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
      
      // Query parametrelerinden voice ve language bilgisini al
      let voiceFromQuery = null;
      let languageFromQuery = 'tr'; // Default: Türkçe
      try {
        if (req.url && req.url.includes('?')) {
          const queryString = req.url.split('?')[1];
          const params = new URLSearchParams(queryString);
          voiceFromQuery = params.get('voice');
          const lang = params.get('language');
          if (lang && (lang === 'tr' || lang === 'en')) {
            languageFromQuery = lang;
          }
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
        language: languageFromQuery,
        sttStart: null,
        llmStart: null,
        pendingChunks: [],
        chunkProcessingTimer: null
      };

      this.clients.set(clientId, client);
      if (client.voice) {
        console.log(`✅ Socket bağlı [${client.id}] Voice: ${client.voice}, Language: ${client.language}`);
      } else {
        console.log(`⚠️ Socket bağlı [${client.id}] Voice bilgisi yok (query parameter), Language: ${client.language}, URL: ${req.url}`);
      }

      ws.on('message', async (data) => {
        try {
          // React Native WebSocket string mesajları binary olarak gönderebilir
          // Önce string olarak kontrol et
          if (typeof data === 'string') {
            // String mesajları kontrol mesajı olarak işle
            console.log(`📨 [Message][${client.id}] String mesaj alındı:`, data.substring(0, 200));
            await this.handleControlMessage(client, data);
          } else if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
            // Binary data - önce JSON string olup olmadığını kontrol et
            try {
              const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
              
              // İlk byte'ı kontrol et - eğer 0 veya 1 ise audio/video chunk'ı
              const firstByte = buffer[0];
              
              if (firstByte === 0 || firstByte === 1) {
                // Audio/video chunk'ı
                this.enqueueChunk(client, data);
              } else {
                // JSON string olabilir - string'e çevir ve kontrol et
                const text = buffer.toString('utf8');
                // JSON string kontrolü: { ile başlıyor ve "type" içeriyor mu?
                if (text.trim().startsWith('{') && (text.includes('"type"') || text.includes("'type'"))) {
                  // JSON mesajı - kontrol mesajı olarak işle
                  console.log(`📨 [Message][${client.id}] Binary'den JSON mesaj alındı:`, text.substring(0, 200));
                  await this.handleControlMessage(client, text);
                } else if (buffer.length < 100) {
                  // Çok küçük buffer - muhtemelen JSON string
                  console.log(`📨 [Message][${client.id}] Küçük binary data, JSON olarak deneniyor:`, text.substring(0, 200));
                  try {
                    await this.handleControlMessage(client, text);
                  } catch (e) {
                    // JSON değilse audio chunk olarak işle
                    console.warn(`⚠️ [Message][${client.id}] JSON parse edilemedi, audio chunk olarak işleniyor`);
                    this.enqueueChunk(client, data);
                  }
                } else {
                  // Büyük binary data - muhtemelen audio chunk
                  this.enqueueChunk(client, data);
                }
              }
            } catch (parseError) {
              // Parse edilemezse audio chunk olarak işle
              console.warn(`⚠️ [Message][${client.id}] Binary data parse edilemedi, audio chunk olarak işleniyor:`, parseError.message);
              this.enqueueChunk(client, data);
            }
          } else {
            console.log(`⚠️ [Message][${client.id}] Bilinmeyen mesaj tipi:`, typeof data);
          }
        } catch (error) {
          console.error(`❌ [Message][${client.id}] Mesaj işleme hatası:`, error.message);
          this.sendError(client.ws, error.message);
        }
      });

      ws.on('close', () => {
        console.log(`🔌 [Disconnect][${client.id}] Client bağlantısı kapandı`);
        this.cleanupClient(client);
        this.clients.delete(clientId);
      });

      ws.on('error', (error) => {
        console.error(`❌ [Error][${client.id}] WebSocket hatası:`, error.message);
        this.cleanupClient(client);
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
    
    // Chunk processing'i optimize et - queue'da bekleyen chunk varsa birleştir
    // Bu sayede FFmpeg çağrılarını azaltırız
    if (!client.pendingChunks) {
      client.pendingChunks = [];
    }
    
    client.pendingChunks.push(buffer);
    
    // Eğer zaten bir chunk processing timer varsa, iptal et
    if (client.chunkProcessingTimer) {
      clearTimeout(client.chunkProcessingTimer);
    }
    
    // Kısa bir delay ile chunk'ları topla ve birlikte işle
    // Bu sayede birden fazla chunk gelirse tek seferde işleriz
    client.chunkProcessingTimer = setTimeout(() => {
      if (client.pendingChunks && client.pendingChunks.length > 0) {
        const chunksToProcess = client.pendingChunks;
        client.pendingChunks = [];
        client.chunkProcessingTimer = null;
        
        // Eğer birden fazla chunk varsa, birleştir
        const combinedBuffer = chunksToProcess.length > 1 
          ? Buffer.concat(chunksToProcess)
          : chunksToProcess[0];
        
        if (chunksToProcess.length > 1) {
          console.log(`📦 [Batch][${client.id}] ${chunksToProcess.length} chunk birleştirildi (${combinedBuffer.length} bytes)`);
        }
        
        client.processingQueue = client.processingQueue
          .then(() => this.processChunk(client, combinedBuffer))
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
    }, 50); // 50ms delay - chunk'ları topla
  }

  async processChunk(client, audioBuffer) {
    // Audio buffer'ı kontrol et - geçersizse işleme
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0 || audioBuffer.length < 100) {
      console.warn(`⚠️ [Chunk][${client.id}] Geçersiz audio buffer, atlanıyor`);
      return;
    }

    if (!client.streamingSession) {
      const session = aiService.createStreamingSession((result) => {
        this.handleStreamingResult(client, result);
      }, client.language || 'tr');

      if (!session) {
        console.warn(`⚠️ [Chunk][${client.id}] STT oturumu başlatılamadı`);
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
      } else if (error.message?.includes('ffmpeg') || error.message?.includes('Invalid data')) {
        // FFmpeg hataları - geçersiz audio buffer, session'ı iptal et ve yeni session başlat
        console.warn(`⚠️ [FFmpeg Error][${client.id}] Geçersiz audio data, session iptal ediliyor: ${error.message}`);
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
        // Hata mesajı gönderme, sadece log'la - bir sonraki geçerli chunk'ta yeni session başlatılacak
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
      console.log(`📋 [Control][${client.id}] Mesaj parse edildi:`, message.type, message.text ? `"${message.text.substring(0, 50)}..."` : '');
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
      case 'text_message':
        // Text mesajı direkt LLM'e gönder (STT yapmadan)
        // Mevcut STT session'ını iptal et ama ses kaydını bozma
        if (client.streamingSession) {
          try {
            client.streamingSession.cancel();
            console.log(`📝 [Text Message][${client.id}] Mevcut STT session iptal edildi`);
          } catch (e) {
            // Ignore cancel errors
          }
          client.streamingSession = null;
        }
        client.currentText = '';
        client.lastSentText = '';
        client.sttStart = null;
        
        if (typeof message.text === 'string' && message.text.trim().length > 0) {
          const userText = message.text.trim();
          console.log(`📝 [Text Message][${client.id}] ${userText} -> LLM'e gönderiliyor...`);
          client.llmStart = Date.now();
          // Processing queue'yu await et, sonra direkt çalıştır
          // Text mesajı için öncelikli işleme
          client.processingQueue = client.processingQueue
            .then(async () => {
              console.log(`🚀 [Text Message][${client.id}] LLM+TTS başlatılıyor...`);
              await this.sendAssistantResponse(client, userText);
            })
            .catch((error) => {
              console.error(`❌ [Text Message][${client.id}] LLM+TTS hatası:`, error.message);
              this.sendError(client.ws, 'Cevap oluşturulamadı');
            });
        } else {
          console.warn(`⚠️ [Text Message][${client.id}] Geçersiz text mesajı`);
        }
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

      console.log(`🤖 [LLM+TTS][${client.id}][voice:${client.voice}] Başlatılıyor: "${userText.substring(0, 50)}..."`);
      const { replyText, audioBuffer } = await aiService.generateAssistantReplyWithTTS(
        userText,
        client.voice
      );
      const llmDuration = client.llmStart ? `${Date.now() - client.llmStart}ms` : 'N/A';
      console.log(`✅ [LLM+TTS][${client.id}][voice:${client.voice}] Tamamlandı (${llmDuration}): "${replyText.substring(0, 50)}..."`);

      // LLM cevabını gönder
      this.sendMessage(client.ws, {
        type: 'llm_response',
        text: replyText
      });
      console.log(`📤 [LLM Response][${client.id}] Mesaj gönderildi`);

      // TTS audio'yu gönder
      if (audioBuffer) {
        const audioBase64 = audioBuffer.toString('base64');
        this.sendMessage(client.ws, {
          type: 'tts_audio',
          audio: audioBase64,
          mimeType: 'audio/mpeg'
        });
        console.log(`📤 [TTS Audio][${client.id}] Audio gönderildi (${audioBase64.length} bytes)`);
      } else {
        console.warn(`⚠️ [TTS Audio][${client.id}] Audio buffer boş`);
      }
      client.llmStart = null;
    } catch (error) {
      console.error(`❌ [LLM+TTS][${client.id}] Hata:`, error.message);
      this.sendError(client.ws, 'Cevap oluşturulamadı');
    }
  }

  cleanupClient(client) {
    // 1. Chunk processing timer'ı iptal et
    if (client.chunkProcessingTimer) {
      clearTimeout(client.chunkProcessingTimer);
      client.chunkProcessingTimer = null;
    }
    
    // 2. Pending chunk'ları temizle
    if (client.pendingChunks) {
      client.pendingChunks = [];
    }
    
    // 3. STT session'ı kapat (ÖNEMLİ!)
    if (client.streamingSession) {
      try {
        console.log(`🧹 [Cleanup][${client.id}] STT session kapatılıyor...`);
        client.streamingSession.cancel();
        client.streamingSession = null;
        console.log(`✅ [Cleanup][${client.id}] STT session kapatıldı`);
      } catch (error) {
        console.warn(`⚠️ [Cleanup][${client.id}] STT session kapatılamadı:`, error.message);
        client.streamingSession = null;
      }
    }
    
    // 4. Client state'ini temizle
    client.currentText = '';
    client.lastSentText = '';
    client.sttStart = null;
    client.llmStart = null;
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

const s2sWebSocketService = new SpeechWebSocketService();
module.exports = s2sWebSocketService;
