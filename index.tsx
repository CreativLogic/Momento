/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';

interface TranscriptionEntry {
  speaker: 'user' | 'ai';
  text: string;
  isFinal: boolean;
}

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = '';
  @state() error = '';
  @state() selectedVoice = 'Zephyr';
  @state() conversation: TranscriptionEntry[] = [];

  private readonly voices = [
    'Zephyr',
    'Puck',
    'Charon',
    'Kore',
    'Fenrir',
    'Orus',
  ];

  private client: GoogleGenAI;
  private sessionPromise: Promise<Session>;
  // FIX: Cast window to `any` to access vendor-prefixed `webkitAudioContext`.
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  // FIX: Cast window to `any` to access vendor-prefixed `webkitAudioContext`.
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: MediaStreamAudioSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: white;
      font-family: sans-serif;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.1);
        width: 64px;
        height: 64px;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
        background: rgba(255, 255, 255, 0.1);
      }

      #startButton[disabled],
      #stopButton[disabled] {
        display: none;
      }
    }

    .voice-selector {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      color: white;
      font-family: sans-serif;
    }

    .voice-selector label {
      font-size: 16px;
    }

    .voice-selector select {
      background: rgba(40, 40, 50, 0.8);
      color: #e0e0e0;
      border: 1px solid rgba(100, 100, 255, 0.5);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 16px;
      cursor: pointer;
      outline: none;
      transition: background 0.2s, border-color 0.2s;
    }

    .voice-selector select:hover {
      background: rgba(60, 60, 80, 0.9);
      border-color: rgba(120, 120, 255, 0.8);
    }

    .voice-selector select:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      border-color: rgba(255, 255, 255, 0.2);
    }

    .transcript-container {
      position: absolute;
      top: 20px;
      left: 20px;
      right: 20px;
      bottom: 30vh;
      color: white;
      font-family: sans-serif;
      background: rgba(0, 0, 0, 0.2);
      border-radius: 12px;
      padding: 20px;
      overflow-y: auto;
      z-index: 5;
    }

    .transcript-entry {
      margin-bottom: 12px;
      line-height: 1.5;
    }

    .transcript-entry strong {
      font-weight: bold;
    }

    .user-text strong {
      color: #87cefa; /* Light Sky Blue */
    }

    .ai-text strong {
      color: #98fb98; /* Pale Green */
    }

    .cursor {
      display: inline-block;
      width: 8px;
      height: 1.2em;
      background-color: white;
      animation: blink 1s step-end infinite;
      vertical-align: text-bottom;
      margin-left: 4px;
    }

    @keyframes blink {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0;
      }
    }

    @media (max-width: 600px) {
      .controls button {
        width: 56px;
        height: 56px;
      }

      .controls button svg {
        width: 32px;
        height: 32px;
      }

      .transcript-container {
        top: 10px;
        left: 10px;
        right: 10px;
        padding: 15px;
        font-size: 14px;
      }
    }
  `;

  constructor() {
    super();
    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });

    this.outputNode.connect(this.outputAudioContext.destination);

    this.initSession();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private initSession() {
    this.initAudio();
    const model = 'gemini-2.5-flash-native-audio-preview-09-2025';

    this.sessionPromise = this.client.live.connect({
      model: model,
      callbacks: {
        onopen: () => {
          this.updateStatus('Opened');
        },
        onmessage: async (message: LiveServerMessage) => {
          const audio = message.serverContent?.modelTurn?.parts[0]?.inlineData;

          if (audio) {
            this.nextStartTime = Math.max(
              this.nextStartTime,
              this.outputAudioContext.currentTime,
            );

            const audioBuffer = await decodeAudioData(
              decode(audio.data),
              this.outputAudioContext,
              24000,
              1,
            );
            const source = this.outputAudioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.outputNode);
            source.addEventListener('ended', () => {
              this.sources.delete(source);
            });

            source.start(this.nextStartTime);
            this.nextStartTime = this.nextStartTime + audioBuffer.duration;
            this.sources.add(source);
          }

          if (message.serverContent?.inputTranscription) {
            const text = message.serverContent.inputTranscription.text;
            const lastEntry = this.conversation[this.conversation.length - 1];
            if (
              lastEntry &&
              lastEntry.speaker === 'user' &&
              !lastEntry.isFinal
            ) {
              this.conversation = [
                ...this.conversation.slice(0, -1),
                {...lastEntry, text: lastEntry.text + text},
              ];
            } else {
              this.conversation = [
                ...this.conversation,
                {speaker: 'user', text, isFinal: false},
              ];
            }
          }

          if (message.serverContent?.outputTranscription) {
            const text = message.serverContent.outputTranscription.text;
            const lastEntry = this.conversation[this.conversation.length - 1];
            if (
              lastEntry &&
              lastEntry.speaker === 'ai' &&
              !lastEntry.isFinal
            ) {
              this.conversation = [
                ...this.conversation.slice(0, -1),
                {...lastEntry, text: lastEntry.text + text},
              ];
            } else {
              this.conversation = [
                ...this.conversation,
                {speaker: 'ai', text, isFinal: false},
              ];
            }
          }

          if (message.serverContent?.turnComplete) {
            this.conversation = this.conversation.map((entry) =>
              entry.isFinal ? entry : {...entry, isFinal: true},
            );
          }

          const interrupted = message.serverContent?.interrupted;
          if (interrupted) {
            for (const source of this.sources.values()) {
              source.stop();
              this.sources.delete(source);
            }
            this.nextStartTime = 0;
          }
        },
        onerror: (e: ErrorEvent) => {
          this.updateError(e.message);
        },
        onclose: (e: CloseEvent) => {
          this.updateStatus('Close:' + e.reason);
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {prebuiltVoiceConfig: {voiceName: this.selectedVoice}},
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    });

    this.sessionPromise.catch((e) => {
      console.error(e);
      this.updateError(e.message ?? 'Failed to initialize session');
    });
  }

  private updateStatus(msg: string) {
    this.status = msg;
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    this.inputAudioContext.resume();

    this.updateStatus('Requesting microphone access...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.updateStatus('Microphone access granted. Starting capture...');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 4096;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        this.sessionPromise.then((session) => {
          session.sendRealtimeInput({media: createBlob(pcmData)});
        });
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.updateStatus('🔴 Recording...');
    } catch (err) {
      console.error('Error starting recording:', err);
      this.updateStatus(`Error: ${err.message}`);
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext)
      return;

    this.updateStatus('Stopping recording...');

    this.isRecording = false;

    if (this.scriptProcessorNode && this.sourceNode && this.inputAudioContext) {
      this.scriptProcessorNode.disconnect();
      this.sourceNode.disconnect();
    }

    this.scriptProcessorNode = null;
    this.sourceNode = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.updateStatus('Recording stopped.');
  }

  private reset() {
    if (this.sessionPromise) {
      this.sessionPromise
        .then((session) => session.close())
        .catch(console.error);
    }
    this.conversation = [];
    this.initSession();
    this.updateStatus('Session cleared.');
  }

  private handleVoiceChange(e: Event) {
    this.selectedVoice = (e.target as HTMLSelectElement).value;
    this.reset();
  }

  private exportTranscript() {
    if (this.conversation.length === 0) return;

    const transcriptText = this.conversation
      .map(
        (entry) =>
          `${entry.speaker === 'user' ? 'User' : 'AI'}: ${entry.text}`,
      )
      .join('\n\n');

    const blob = new Blob([transcriptText], {type: 'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'conversation-transcript.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  render() {
    return html`
      <div>
        <div class="transcript-container" aria-live="polite" aria-atomic="true">
          ${this.conversation.map(
            (entry) => html`
              <div
                class="transcript-entry ${entry.speaker === 'user'
                  ? 'user-text'
                  : 'ai-text'}">
                <strong>${entry.speaker === 'user' ? 'You' : 'AI'}:</strong>
                ${entry.text}${!entry.isFinal
                  ? html`<span class="cursor"></span>`
                  : ''}
              </div>
            `,
          )}
        </div>
        <div class="controls">
          <div class="voice-selector">
            <label for="voice-select" aria-label="Select AI Voice"
              >Voice:</label
            >
            <select
              id="voice-select"
              @change=${this.handleVoiceChange}
              ?disabled=${this.isRecording}>
              ${this.voices.map(
                (voice) =>
                  html`<option
                    value=${voice}
                    ?selected=${voice === this.selectedVoice}>
                    ${voice}
                  </option>`,
              )}
            </select>
          </div>
          <button
            id="exportButton"
            @click=${this.exportTranscript}
            ?disabled=${this.conversation.length === 0}
            aria-label="Export Transcript">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="40px"
              viewBox="0 -960 960 960"
              width="40px"
              fill="#ffffff">
              <path
                d="M480-320 280-520l60-60 140 140v-440h80v440l140-140 60 60-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z" />
            </svg>
          </button>
          <button
            id="resetButton"
            @click=${this.reset}
            ?disabled=${this.isRecording}
            aria-label="Reset Session">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="40px"
              viewBox="0 -960 960 960"
              width="40px"
              fill="#ffffff">
              <path
                d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
            </svg>
          </button>
          <button
            id="startButton"
            @click=${this.startRecording}
            ?disabled=${this.isRecording}
            aria-label="Start Recording">
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#c80000"
              xmlns="http://www.w3.org/2000/svg">
              <circle cx="50" cy="50" r="50" />
            </svg>
          </button>
          <button
            id="stopButton"
            @click=${this.stopRecording}
            ?disabled=${!this.isRecording}
            aria-label="Stop Recording">
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#000000"
              xmlns="http://www.w3.org/2000/svg">
              <rect x="0" y="0" width="100" height="100" rx="15" />
            </svg>
          </button>
        </div>

        <div id="status">${this.error || this.status}</div>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}
