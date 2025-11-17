const WebSocket = require('ws');
const aiService = require('./ai.service');

class SpeechWebSocketService {
  constructor() {
    this.wss = null;
    this.clients = new Map();
  }

  initialize(server) {
    this.wss = new WebSocket.Server({
      server,
      path: '/ws/stt',
      perMessageDeflate: false
    });

    this.wss.on('connection', (ws) => {
      const clientId = `client_${Date.now()}`;
      const client = {
        ws,
        id: clientId,
        streamingSession: null,
        currentText: '',
        processingQueue: Promise.resolve(),
        lastSentText: ''
      };

      this.clients.set(clientId, client);
      console.log('Socket bağlı');

      ws.on('message', async (data) => {
        try {
          if (typeof data === 'string') {
            await this.handleControlMessage(client, data);
          } else if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
            this.enqueueChunk(client, data);
          }
        } catch (error) {
          this.sendError(client.ws, error.message);
        }
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
      });

      ws.on('error', () => {
        this.clients.delete(clientId);
      });

      this.sendMessage(ws, {
        type: 'connected',
        clientId
      });
    });
  }

  enqueueChunk(client, data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    client.processingQueue = client.processingQueue
      .then(() => this.processChunk(client, buffer))
      .catch((error) => {
        this.sendError(client.ws, error.message);
      });
  }

  async processChunk(client, audioBuffer) {
    if (!client.streamingSession) {
      const session = aiService.createStreamingSession((result) => {
        this.handleStreamingResult(client, result);
      });

      if (!session) {
        this.sendError(client.ws, 'STT oturumu başlatılamadı');
        return;
      }

      client.streamingSession = session;
    }

    await client.streamingSession.writeChunk(audioBuffer);
  }

  handleStreamingResult(client, result) {
    if (result?.error) {
      if (client.streamingSession) {
        client.streamingSession.cancel();
        client.streamingSession = null;
      }
      client.currentText = '';
      client.lastSentText = '';
      this.sendError(client.ws, result.message || 'STT hatası');
      return;
    }

    const text = result?.text?.replace(/\s+/g, ' ').trim();
    if (!text) {
      return;
    }

    client.currentText = text;

    if (!result.isFinal) {
      if (text !== client.lastSentText) {
        client.lastSentText = text;
        console.log(`🗣️ [STT Chunk][${client.id}] ${text}`);
        this.sendMessage(client.ws, {
          type: 'stt_chunk',
          text
        });
      }
      return;
    }

    client.lastSentText = '';
    console.log(`✅ [STT Final][${client.id}] ${text}`);
    this.sendMessage(client.ws, {
      type: 'transcription_complete',
      text
    });
  }

  async handleControlMessage(client, rawMessage) {
    let message = null;
    try {
      message = JSON.parse(rawMessage);
    } catch (error) {
      this.sendError(client.ws, 'Geçersiz kontrol mesajı');
      return;
    }

    switch (message.type) {
      case 'speech_end':
        await client.processingQueue;
        await this.finalizeTranscription(client);
        break;
      case 'reset':
        client.currentText = '';
        this.sendMessage(client.ws, { type: 'reset_ack' });
        break;
      case 'ping':
        this.sendMessage(client.ws, { type: 'pong' });
        break;
      default:
        this.sendError(client.ws, 'Bilinmeyen mesaj tipi');
        break;
    }
  }

  async finalizeTranscription(client) {
    try {
      if (client.streamingSession) {
        await client.streamingSession.finish();
        client.streamingSession = null;
      }
    } catch (error) {
      console.error('Streaming session finish error:', error);
    }

    if (client.currentText) {
      const finalText = client.currentText;
      client.currentText = '';
      console.log(`✅ [STT Final][${client.id}] ${finalText}`);
      this.sendMessage(client.ws, {
        type: 'transcription_complete',
        text: finalText
      });
    } else {
      this.sendMessage(client.ws, {
        type: 'transcription_complete',
        text: ''
      });
    }

    client.lastSentText = '';
  }

  sendMessage(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  sendError(ws, errorMessage) {
    this.sendMessage(ws, {
      type: 'error',
      message: errorMessage
    });
  }
}

module.exports = new SpeechWebSocketService();