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

    this.wss.on('connection', (ws, req) => {
      const clientId = `client_${Date.now()}`;
      
      // Query parametrelerinden voice bilgisini al
      let voiceFromQuery = null;
      try {
        if (req.url && req.url.includes('?')) {
          const queryString = req.url.split('?')[1];
          const params = new URLSearchParams(queryString);
          voiceFromQuery = params.get('voice');
        }
      } catch (error) {
        console.error('❌ Query parameter parse hatası:', error.message);
      }
      
      const client = {
        ws,
        id: clientId,
        streamingSession: null,
        currentText: '',
        processingQueue: Promise.resolve(),
        lastSentText: '',
        voice: voiceFromQuery ? voiceFromQuery.trim() : null,
        sttStart: null,
        llmStart: null
      };

      this.clients.set(clientId, client);
      if (client.voice) {
        console.log(`✅ Socket bağlı [${client.id}] Voice (query): ${client.voice}`);
      } else {
        console.log(`⚠️ Socket bağlı [${client.id}] Voice bilgisi yok (query parameter), URL: ${req.url}`);
      }

      ws.on('message', async (data) => {
        try {
          if (typeof data === 'string') {
            // String mesajları kontrol mesajı olarak işle
            console.log(`📨 [Message][${client.id}] String mesaj alındı:`, data.substring(0, 200));
            await this.handleControlMessage(client, data);
          } else if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
            // Binary data ses chunk'ı
            this.enqueueChunk(client, data);
          } else {
            console.log(`⚠️ [Message][${client.id}] Bilinmeyen mesaj tipi:`, typeof data);
          }
        } catch (error) {
          console.error(`❌ [Message][${client.id}] Mesaj işleme hatası:`, error.message);
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
        // STT timeout hatalarını hata mesajı olarak gönderme, sadece log'la
        if (error.code === 11 || error.message?.includes('timeout') || error.message?.includes('Timeout')) {
          console.log(`⏸️ [STT Timeout][${client.id}] Chunk işlenirken timeout (pause veya timeout)`);
          // Hata mesajı gönderme
        } else {
          console.error(`❌ [Chunk Error][${client.id}]:`, error.message);
          this.sendError(client.ws, error.message);
        }
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
      client.sttStart = Date.now();
    }

    try {
      await client.streamingSession.writeChunk(audioBuffer);
    } catch (error) {
      // STT timeout veya diğer hatalar - session'ı iptal et ve temizle
      if (error.code === 11 || error.message?.includes('timeout') || error.message?.includes('Timeout')) {
        console.log(`⏸️ [STT Timeout][${client.id}] Session iptal ediliyor (pause veya timeout)`);
        if (client.streamingSession) {
          try {
            client.streamingSession.cancel();
          } catch (e) {
            // Ignore cancel errors
          }
          client.streamingSession = null;
        }
        client.currentText = '';
        client.lastSentText = '';
        client.sttStart = null;
        // Hata mesajı gönderme, sadece log'la
      } else {
        console.error(`❌ [STT Error][${client.id}]:`, error.message);
        // Diğer hatalar için error gönder
        this.sendError(client.ws, `STT hatası: ${error.message}`);
      }
    }
  }

  handleStreamingResult(client, result) {
    if (result?.error) {
      // STT timeout hatası - hata mesajı gönderme, sadece log'la ve temizle
      if (result.message?.includes('timeout') || result.message?.includes('Timeout') || result.code === 11) {
        console.log(`⏸️ [STT Timeout][${client.id}] Session iptal ediliyor`);
        if (client.streamingSession) {
          try {
            client.streamingSession.cancel();
          } catch (e) {
            // Ignore cancel errors
          }
          client.streamingSession = null;
        }
        client.currentText = '';
        client.lastSentText = '';
        client.sttStart = null;
        // Hata mesajı gönderme, sadece log'la
        return;
      }
      
      // Diğer hatalar için error gönder
      if (client.streamingSession) {
        try {
          client.streamingSession.cancel();
        } catch (e) {
          // Ignore cancel errors
        }
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
    const sttDuration = client.sttStart ? `${Date.now() - client.sttStart}ms` : 'N/A';
    console.log(`✅ [STT Final][${client.id}][voice:${client.voice}] ${text} (${sttDuration})`);
    this.sendMessage(client.ws, {
      type: 'transcription_complete',
      text
    });

    client.llmStart = Date.now();
    client.processingQueue = client.processingQueue.then(() =>
      this.sendAssistantResponse(client, text)
    );
  }

  async handleControlMessage(client, rawMessage) {
    let message = null;
    try {
      message = JSON.parse(rawMessage);
      console.log(`📋 [Control][${client.id}] Mesaj parse edildi:`, message.type, message);
    } catch (error) {
      console.error(`❌ [Control][${client.id}] JSON parse hatası:`, error.message, 'Raw:', rawMessage.substring(0, 200));
      this.sendError(client.ws, 'Geçersiz kontrol mesajı');
      return;
    }

    switch (message.type) {
      case 'speech_end':
        await client.processingQueue;
        await this.finalizeTranscription(client);
        break;
      case 'speech_pause':
        // Pause durumu: STT session'ını iptal et, timeout'u önle
        if (client.streamingSession) {
          try {
            client.streamingSession.cancel();
            client.streamingSession = null;
            console.log(`⏸️ [Pause][${client.id}] STT session iptal edildi`);
          } catch (error) {
            console.error(`❌ [Pause][${client.id}] STT session iptal hatası:`, error.message);
          }
        }
        client.currentText = '';
        client.lastSentText = '';
        client.sttStart = null;
        break;
      case 'config':
        console.log(`🔧 [Config][${client.id}] Config mesajı alındı, voice:`, message.voice);
        if (typeof message.voice === 'string' && message.voice.trim().length > 0) {
          client.voice = message.voice.trim();
          console.log(`✅ [Config][${client.id}] Voice set edildi: ${client.voice}`);
        } else {
          console.warn(`⚠️ [Config][${client.id}] Geçersiz voice bilgisi:`, message.voice, typeof message.voice);
        }
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
      const sttDuration = client.sttStart ? `${Date.now() - client.sttStart}ms` : 'N/A';
      console.log(`✅ [STT Final][${client.id}][voice:${client.voice}] ${finalText} (${sttDuration})`);
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
    client.sttStart = null;
  }

  async sendAssistantResponse(client, userText) {
    try {
      if (!client.voice || !client.voice.trim()) {
        throw new Error('Voice bilgisi yok, config mesajı bekleniyor');
      }

      const { replyText, audioBuffer } = await aiService.generateAssistantReplyWithTTS(
        userText,
        client.voice
      );
    const llmDuration = client.llmStart ? `${Date.now() - client.llmStart}ms` : 'N/A';
    console.log(`🤖 [LLM+TTS][${client.id}][voice:${client.voice}] tamamlandı (${llmDuration})`);

      this.sendMessage(client.ws, {
        type: 'llm_response',
        text: replyText
      });

      if (audioBuffer) {
        this.sendMessage(client.ws, {
          type: 'tts_audio',
          audio: audioBuffer.toString('base64'),
          mimeType: 'audio/mpeg'
        });
      }
      client.llmStart = null;
    } catch (error) {
      console.error('Assistant response error:', error);
      this.sendError(client.ws, 'Cevap oluşturulamadı');
    }
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