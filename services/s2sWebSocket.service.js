const WebSocket = require('ws');
const aiService = require('./ai.service');
const jwt = require('jsonwebtoken');
const { User } = require('../models/User');

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

    this.wss.on('connection', async (ws, req) => {
      const clientId = `client_${Date.now()}`;
      
      let voiceFromQuery = null;
      let languageFromQuery = 'tr';
      let tokenFromQuery = null;
      let userId = null;
      let user = null;
      
      try {
        if (req.url && req.url.includes('?')) {
          const queryString = req.url.split('?')[1];
          const params = new URLSearchParams(queryString);
          voiceFromQuery = params.get('voice');
          const lang = params.get('language');
          if (lang && (lang === 'tr' || lang === 'en')) {
            languageFromQuery = lang;
          }
          tokenFromQuery = params.get('token');
        }
      } catch (error) {
        console.error('❌ Query parameter parse hatası:', error.message);
      }
      
      if (tokenFromQuery) {
        try {
          const payload = jwt.verify(tokenFromQuery, process.env.ACCESS_TOKEN_SECRET);
          userId = payload.userId;
          console.log(`🔐 [Auth][${clientId}] User ID: ${userId}`);
          
          user = await User.findById(userId).select('demoMinutesRemaining activeCouponCode courseCode');
          if (user && user.demoMinutesRemaining && user.demoMinutesRemaining > 0) {
            console.log(`⏱️ [Demo][${clientId}] Demo süresi başlatıldı: ${user.demoMinutesRemaining} dakika`);
          }
        } catch (error) {
          console.warn(`⚠️ [Auth][${clientId}] Token geçersiz veya parse edilemedi:`, error.message);
        }
      }
      
      const client = {
        ws,
        id: clientId,
        userId: userId,
        user: user,
        streamingSession: null,
        currentText: '',
        processingQueue: Promise.resolve(),
        lastSentText: '',
        voice: voiceFromQuery ? voiceFromQuery.trim() : null,
        language: languageFromQuery,
        sttStart: null,
        llmStart: null,
        pendingChunks: [],
        chunkProcessingTimer: null,
        demoStartTime: null,
        demoInitialMinutes: null,
        demoTimerInterval: null
      };

      this.clients.set(clientId, client);
      if (client.voice) {
        console.log(`✅ Socket bağlı [${client.id}] Voice: ${client.voice}, Language: ${client.language}`);
      } else {
        console.log(`⚠️ Socket bağlı [${client.id}] Voice bilgisi yok (query parameter), Language: ${client.language}, URL: ${req.url}`);
      }

      if (client.user && client.user.demoMinutesRemaining && client.user.demoMinutesRemaining > 0) {
        this.startDemoTimer(client);
      }

      ws.on('message', async (data) => {
        try {
          if (typeof data === 'string') {
            console.log(`📨 [Message][${client.id}] String mesaj alındı:`, data.substring(0, 200));
            await this.handleControlMessage(client, data);
          } else if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
            try {
              const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
              
              const firstByte = buffer[0];
              
              if (firstByte === 0 || firstByte === 1) {
                this.enqueueChunk(client, data);
              } else {
                const text = buffer.toString('utf8');
                if (text.trim().startsWith('{') && (text.includes('"type"') || text.includes("'type'"))) {
                  console.log(`📨 [Message][${client.id}] Binary'den JSON mesaj alındı:`, text.substring(0, 200));
                  await this.handleControlMessage(client, text);
                } else if (buffer.length < 100) {
                  console.log(`📨 [Message][${client.id}] Küçük binary data, JSON olarak deneniyor:`, text.substring(0, 200));
                  try {
                    await this.handleControlMessage(client, text);
                  } catch (e) {
                    console.warn(`⚠️ [Message][${client.id}] JSON parse edilemedi, audio chunk olarak işleniyor`);
                    this.enqueueChunk(client, data);
                  }
                } else {
                  this.enqueueChunk(client, data);
                }
              }
            } catch (parseError) {
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

      ws.on('close', async () => {
        console.log(`🔌 [Disconnect][${client.id}] Client bağlantısı kapandı`);
        await this.stopDemoTimer(client);
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
    
    if (!client.pendingChunks) {
      client.pendingChunks = [];
    }
    
    client.pendingChunks.push(buffer);
    
    if (client.chunkProcessingTimer) {
      clearTimeout(client.chunkProcessingTimer);
    }
    
    client.chunkProcessingTimer = setTimeout(() => {
      if (client.pendingChunks && client.pendingChunks.length > 0) {
        const chunksToProcess = client.pendingChunks;
        client.pendingChunks = [];
        client.chunkProcessingTimer = null;
        
        const combinedBuffer = chunksToProcess.length > 1 
          ? Buffer.concat(chunksToProcess)
          : chunksToProcess[0];
        
        if (chunksToProcess.length > 1) {
          console.log(`📦 [Batch][${client.id}] ${chunksToProcess.length} chunk birleştirildi (${combinedBuffer.length} bytes)`);
        }
        
        client.processingQueue = client.processingQueue
          .then(() => this.processChunk(client, combinedBuffer))
          .catch((error) => {
            if (error.code === 11 || error.message?.includes('timeout') || error.message?.includes('Timeout')) {
              console.log(`⏸️ [STT Timeout][${client.id}] Chunk işlenirken timeout (pause veya timeout)`);
            } else {
              console.error(`❌ [Chunk Error][${client.id}]:`, error.message);
              this.sendError(client.ws, error.message);
            }
          });
      }
    }, 50);
  }

  async processChunk(client, audioBuffer) {
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
      if (error.code === 11 || error.message?.includes('timeout') || error.message?.includes('Timeout')) {
        console.log(`⏸️ [STT Timeout][${client.id}] Session iptal ediliyor (pause veya timeout)`);
        if (client.streamingSession) {
          try {
            client.streamingSession.cancel();
          } catch (e) {
          }
          client.streamingSession = null;
        }
        client.currentText = '';
        client.lastSentText = '';
        client.sttStart = null;
      } else if (error.message?.includes('ffmpeg') || error.message?.includes('Invalid data')) {
        console.warn(`⚠️ [FFmpeg Error][${client.id}] Geçersiz audio data, session iptal ediliyor: ${error.message}`);
        if (client.streamingSession) {
          try {
            client.streamingSession.cancel();
          } catch (e) {
          }
          client.streamingSession = null;
        }
        client.currentText = '';
        client.lastSentText = '';
        client.sttStart = null;
      } else {
        console.error(`❌ [STT Error][${client.id}]:`, error.message);
        this.sendError(client.ws, `STT hatası: ${error.message}`);
      }
    }
  }

  handleStreamingResult(client, result) {
    if (result?.error) {
      if (result.message?.includes('timeout') || result.message?.includes('Timeout') || result.code === 11) {
        console.log(`⏸️ [STT Timeout][${client.id}] Session iptal ediliyor`);
        if (client.streamingSession) {
          try {
            client.streamingSession.cancel();
          } catch (e) {
          }
          client.streamingSession = null;
        }
        client.currentText = '';
        client.lastSentText = '';
        client.sttStart = null;
        return;
      }
      
      if (client.streamingSession) {
        try {
          client.streamingSession.cancel();
        } catch (e) {
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
        if (client.streamingSession) {
          try {
            client.streamingSession.cancel();
            console.log(`📝 [Text Message][${client.id}] Mevcut STT session iptal edildi`);
          } catch (e) {
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

      this.sendMessage(client.ws, {
        type: 'llm_response',
        text: replyText
      });
      console.log(`📤 [LLM Response][${client.id}] Mesaj gönderildi`);

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

  startDemoTimer(client) {
    if (!client.user || !client.user.demoMinutesRemaining || client.user.demoMinutesRemaining <= 0) {
      return;
    }

    if (client.demoTimerInterval) {
      clearInterval(client.demoTimerInterval);
    }

    client.demoStartTime = Date.now();
    client.demoInitialMinutes = client.user.demoMinutesRemaining;
    
    console.log(`⏱️ [Demo Timer][${client.id}] Başlatıldı: ${client.demoInitialMinutes} dakika`);

    client.demoTimerInterval = setInterval(async () => {
      if (!client.ws || client.ws.readyState !== WebSocket.OPEN || !this.clients.has(client.id)) {
        if (client.demoTimerInterval) {
          clearInterval(client.demoTimerInterval);
          client.demoTimerInterval = null;
        }
        return;
      }

      if (!client.user || !client.demoStartTime || !client.demoInitialMinutes) {
        return;
      }

      const now = Date.now();
      const elapsedMs = now - client.demoStartTime;
      const elapsedMinutes = elapsedMs / (1000 * 60);
      const remainingMinutes = Math.max(0, client.demoInitialMinutes - elapsedMinutes);

      const elapsedSeconds = Math.floor((now - (client.lastDemoUpdate || client.demoStartTime)) / 1000);
      
      if (elapsedSeconds >= 10 || remainingMinutes === 0) {
        try {
          const updatedUser = await User.findById(client.userId).select('demoMinutesRemaining');
          if (updatedUser) {
            const calculatedRemaining = Math.max(0, Math.floor(remainingMinutes));
            
            const dbValue = updatedUser.demoMinutesRemaining || 0;
            const difference = Math.abs(dbValue - calculatedRemaining);
            
            if (difference > 1 && dbValue > calculatedRemaining) {
              client.demoInitialMinutes = dbValue;
              client.demoStartTime = Date.now();
              client.lastDemoUpdate = null;
              console.log(`🔄 [Demo Timer][${client.id}] Demo süresi admin tarafından güncellendi: ${dbValue} dakika (fark: ${difference.toFixed(2)} dakika)`);
            }
            
            const currentElapsed = (Date.now() - client.demoStartTime) / (1000 * 60);
            const currentRemaining = Math.max(0, client.demoInitialMinutes - currentElapsed);
            const finalRemaining = Math.max(0, Math.floor(currentRemaining));
            
            updatedUser.demoMinutesRemaining = finalRemaining;
            await updatedUser.save();
            
            client.user.demoMinutesRemaining = finalRemaining;
            client.lastDemoUpdate = now;
            
            console.log(`💾 [Demo Timer][${client.id}] Demo süresi DB'ye kaydedildi: ${finalRemaining} dakika`);
          }
        } catch (error) {
          console.error(`❌ [Demo Timer][${client.id}] Demo süresi güncellenemedi:`, error.message);
        }
      }

      this.sendMessage(client.ws, {
        type: 'demo_timer_update',
        minutesRemaining: remainingMinutes
      });

      if (remainingMinutes <= 0 && client.user && client.userId) {
        try {
          const user = await User.findById(client.userId);
          if (user && user.activeCouponCode) {
            const couponCode = user.activeCouponCode;
            const Coupon = require('../models/Coupon');
            const coupon = await Coupon.findOne({ code: couponCode });
            if (coupon && coupon.isDemo) {
              user.activeCouponCode = null;
              if (user.courseCode === couponCode) {
                user.courseCode = null;
              }
              await user.save();
              console.log(`🧹 [Demo Timer][${client.id}] Demo süresi bitti, aktif kupon kodları temizlendi`);
            }
          }
        } catch (error) {
          console.error(`❌ [Demo Timer][${client.id}] Kupon kodları temizlenemedi:`, error.message);
        }
      }
    }, 1000);
  }

  async stopDemoTimer(client) {
    if (client.demoTimerInterval) {
      clearInterval(client.demoTimerInterval);
      client.demoTimerInterval = null;
    }

    if (client.user && client.userId && client.demoStartTime && client.demoInitialMinutes) {
      try {
        const now = Date.now();
        const elapsedMs = now - client.demoStartTime;
        const elapsedMinutes = elapsedMs / (1000 * 60);
        const remainingMinutes = Math.max(0, client.demoInitialMinutes - elapsedMinutes);

        const user = await User.findById(client.userId);
        if (user) {
          user.demoMinutesRemaining = Math.max(0, Math.floor(remainingMinutes));
          
          if (user.demoMinutesRemaining <= 0 && user.activeCouponCode) {
            const couponCode = user.activeCouponCode;
            const Coupon = require('../models/Coupon');
            const coupon = await Coupon.findOne({ code: couponCode });
            if (coupon && coupon.isDemo) {
              user.activeCouponCode = null;
              if (user.courseCode === couponCode) {
                user.courseCode = null;
              }
              console.log(`🧹 [Demo Timer][${client.id}] Demo süresi bitti, aktif kupon kodları temizlendi`);
            }
          }
          
          await user.save();
          console.log(`💾 [Demo Timer][${client.id}] Socket kapandı, son kalan süre kaydedildi: ${user.demoMinutesRemaining} dakika`);
        }
      } catch (error) {
        console.error(`❌ [Demo Timer][${client.id}] Son kalan süre kaydedilemedi:`, error.message);
      }
    }

    client.demoStartTime = null;
    client.demoInitialMinutes = null;
    client.lastDemoUpdate = null;
  }

  cleanupClient(client) {
    if (client.demoTimerInterval) {
      clearInterval(client.demoTimerInterval);
      client.demoTimerInterval = null;
    }
    
    if (client.chunkProcessingTimer) {
      clearTimeout(client.chunkProcessingTimer);
      client.chunkProcessingTimer = null;
    }
    
    if (client.pendingChunks) {
      client.pendingChunks = [];
    }
    
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
