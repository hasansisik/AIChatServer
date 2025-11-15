const WebSocket = require('ws');
const aiService = require('./ai.service');
const path = require('path');
const fs = require('fs');

class S2SWebSocketService {
  constructor() {
    this.wss = null;
    this.clients = new Map(); // conversation_id -> WebSocket
  }

  // WebSocket server'ı başlat
  initialize(server) {
    this.wss = new WebSocket.Server({ 
      server,
      path: '/ws/s2s',
      perMessageDeflate: false // Binary data için compression kapalı
    });

    this.wss.on('connection', (ws, req) => {
      // Conversation ID'yi URL'den al (örn: /ws/s2s?conversation_id=xxx)
      const url = new URL(req.url, `http://${req.headers.host}`);
      const conversationId = url.searchParams.get('conversation_id');
      const voice = url.searchParams.get('voice') || 'alloy';

      if (!conversationId) {
        ws.close(1008, 'Conversation ID required');
        return;
      }

      // Client'ı kaydet
      const clientId = `${conversationId}_${Date.now()}`;
      this.clients.set(clientId, {
        ws,
        conversationId,
        voice,
        sttChunks: [], // STT chunk'larını biriktir
        isRecording: false, // Konuşma kaydediliyor mu?
        silenceStartTime: null, // Sessizlik ne zaman başladı?
        silenceThreshold: 1500 // 1.5 saniye sessizlik = konuşma bitti (hızlandırıldı)
      });

      console.log('Socket bağlı');

      // Mesaj alma
      ws.on('message', async (data) => {
        try {
            const client = this.clients.get(clientId);
            if (!client) {
              return;
            }

          // Binary data = audio chunk
          if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
            await this.handleAudioChunk(client, data);
          } 
          // String data = control mesajı
          else if (typeof data === 'string') {
            await this.handleControlMessage(client, JSON.parse(data));
          }
          } catch (error) {
            this.sendError(ws, error.message);
          }
      });

        // Bağlantı kapanınca temizle
        ws.on('close', () => {
          this.clients.delete(clientId);
        });

        // Hata durumu
        ws.on('error', (error) => {
          this.clients.delete(clientId);
        });

      // Bağlantı kuruldu mesajı gönder
      this.sendMessage(ws, {
        type: 'connected',
        conversationId,
        voice
      });
      });
  }

  // Audio chunk işle
  async handleAudioChunk(client, audioBuffer) {
    try {
      // VAD kontrolü - dosya boyutu ve süre kontrolü
      const minFileSize = 12000; // 12KB minimum
      const minDuration = 1500; // 1.5 saniye minimum
      
      // Buffer'dan dosya boyutunu al
      if (audioBuffer.length < minFileSize) {
        // Dosya çok küçük - sessizlik/gürültü
        if (client.isRecording && !client.silenceStartTime) {
          client.silenceStartTime = Date.now();
        }
        return;
      }

      // STT yap (streaming değil, chunk chunk)
      const sttResult = await aiService.speechToText(audioBuffer);
      
      if (!sttResult.success || !sttResult.text || sttResult.text.trim().length < 3) {
        // Sessizlik/gürültü - sessizlik timer'ını başlat
        if (client.isRecording) {
          if (!client.silenceStartTime) {
            client.silenceStartTime = Date.now();
          } else {
            // Sessizlik devam ediyor - kontrol et
            const silenceDuration = Date.now() - client.silenceStartTime;
            if (silenceDuration >= client.silenceThreshold) {
              await this.handleSpeechComplete(client);
            }
          }
        }
        return;
      }

      const text = sttResult.text.trim();
      
      // Anlamsız/kısa chunk'ları filtrele
      const filteredText = this.filterMeaninglessChunks(text);
      if (!filteredText) {
        // Anlamsız chunk - sessizlik timer'ını başlat
        if (client.isRecording && !client.silenceStartTime) {
          client.silenceStartTime = Date.now();
        }
        return;
      }
      
      // VAD: Dosya boyutu kontrolü - konuşma için minimum bytes/saniye
      // M4A formatı için: ~25KB/saniye normal konuşma
      // Buffer boyutundan süre tahmin et (yaklaşık)
      const estimatedDurationSeconds = Math.max(1.0, audioBuffer.length / 25000); // En az 1 saniye varsay
      const bytesPerSecond = audioBuffer.length / estimatedDurationSeconds;
      const minBytesPerSecond = 20000; // 20KB/s minimum (daha sıkı kontrol - gürültü filtresi)
      
      if (bytesPerSecond < minBytesPerSecond) {
        // Dosya boyutu düşük - gürültü olabilir
        if (client.isRecording && !client.silenceStartTime) {
          client.silenceStartTime = Date.now();
        }
        return;
      }
      
      // Filtrelenmiş metni kullan
      const finalText = filteredText;
      
      // Konuşma başladı
      if (!client.isRecording) {
        client.isRecording = true;
        client.silenceStartTime = null;
        console.log('Kayıt ediliyor');
        
        // Frontend'e konuşma başladı mesajı gönder
        this.sendMessage(client.ws, {
          type: 'speech_started'
        });
      }
      
      // Yeni STT chunk geldi - sessizlik timer'ını sıfırla (konuşma devam ediyor)
      client.silenceStartTime = null;

      // STT chunk'ını ekle
      client.sttChunks.push(finalText);
      
      // Tüm chunk'ları birleştir ve STT metnini göster
      const combinedText = client.sttChunks.join(' ').trim();
      console.log(`STT: ${combinedText}`);

      // Frontend'e STT chunk gönder (streaming)
      this.sendMessage(client.ws, {
        type: 'stt_chunk',
        text: finalText,
        chunkIndex: client.sttChunks.length - 1
      });
      
      // Cümle tamamlanmış mı kontrol et (noktalama işareti var mı?)
      const punctuationMarks = ['.', '!', '?', ';'];
      const hasPunctuation = punctuationMarks.some(mark => combinedText.trim().endsWith(mark));
      
      // Eğer cümle tamamlanmışsa ve anlamlı bir metin varsa, hemen LLM+TTS yap
      if (hasPunctuation && combinedText.trim().length > 5) {
        // Birleştirilmiş metin ile yanıt ver
        await this.handleSingleChunkResponse(client, combinedText);
        // STT chunk'larını temizle (yeni cümle için)
        client.sttChunks = [];
        client.silenceStartTime = null;
        client.isRecording = false; // Konuşma bitti, yeni konuşma için hazır
      }
      // Cümle tamamlanmamışsa - sessizlik timer'ı zaten sıfırlandı, bir sonraki chunk'ı bekle
    } catch (error) {
      this.sendError(client.ws, error.message);
    }
  }

  // Control mesajı işle
  async handleControlMessage(client, message) {
    switch (message.type) {
      case 'speech_end':
        // Kullanıcı manuel olarak konuşma bitirdi
        await this.handleSpeechComplete(client);
        break;
      case 'reset':
        // STT chunk'larını temizle
        client.sttChunks = [];
        client.isRecording = false;
        client.silenceStartTime = null;
        break;
        default:
          break;
      }
  }

  // Tek bir chunk için hemen yanıt ver (streaming S2S)
  async handleSingleChunkResponse(client, text) {
    try {
      // Frontend'e konuşma tamamlandı mesajı gönder
      this.sendMessage(client.ws, {
        type: 'speech_complete',
        fullText: text
      });

      // LLM streaming yanıt al
      const ttsChunks = [];
      const ttsPromises = [];
      let chunkIndex = 0;

      // LLM streaming yanıt al
      const aiResultPromise = aiService.getAIResponse(text, async (chunkText) => {
        // Her LLM chunk'ını frontend'e gönder (streaming)
        this.sendMessage(client.ws, {
          type: 'llm_chunk',
          text: chunkText,
          chunkIndex: chunkIndex++
        });

        // TTS yap (paralel)
        if (chunkText.trim().length > 0) {
          const currentIndex = chunkIndex - 1;
          const ttsPromise = aiService.textToSpeech(chunkText.trim(), client.voice);
          ttsPromises.push(ttsPromise);

          ttsPromise.then((ttsResult) => {
            if (ttsResult.success) {
              ttsChunks[currentIndex] = ttsResult.audioBuffer;
              
              // TTS chunk'ı frontend'e gönder (streaming)
              this.sendMessage(client.ws, {
                type: 'tts_chunk',
                audioBuffer: ttsResult.audioBuffer.toString('base64'),
                chunkIndex: currentIndex,
                mimeType: 'audio/mpeg'
              });
            }
            }).catch((error) => {
              // Sessizce geç
            });
        }
      });

      // AI response'u bekle
      const aiResult = await aiResultPromise;
      if (!aiResult || !aiResult.success) {
        throw new Error('AI yanıtı alınamadı');
      }

      // Tüm TTS chunk'larının tamamlanmasını bekle
      await Promise.all(ttsPromises);

      // Tamamlandı mesajı gönder
      this.sendMessage(client.ws, {
        type: 'response_complete',
        totalChunks: ttsChunks.length
      });

      } catch (error) {
        this.sendError(client.ws, error.message);
      }
  }

  // Konuşma tamamlandı - LLM + TTS yap (tüm chunk'ları birleştir)
  async handleSpeechComplete(client) {
    if (client.sttChunks.length === 0) {
      client.isRecording = false;
      client.silenceStartTime = null;
      return;
    }

    // STT chunk'larını birleştir
    const fullText = client.sttChunks.join(' ').trim();

    // STT chunk'larını temizle
    client.sttChunks = [];
    client.isRecording = false;
    client.silenceStartTime = null;

    // Frontend'e konuşma tamamlandı mesajı gönder
    this.sendMessage(client.ws, {
      type: 'speech_complete',
      fullText: fullText
    });

    try {
      // LLM streaming yanıt al
      const ttsChunks = [];
      const ttsPromises = [];
      let chunkIndex = 0;

      // LLM streaming yanıt al
      const aiResultPromise = aiService.getAIResponse(fullText, async (chunkText) => {
        // Her LLM chunk'ını frontend'e gönder (streaming)
        this.sendMessage(client.ws, {
          type: 'llm_chunk',
          text: chunkText,
          chunkIndex: chunkIndex++
        });

        // TTS yap (paralel)
        if (chunkText.trim().length > 0) {
          const currentIndex = chunkIndex - 1;
          const ttsPromise = aiService.textToSpeech(chunkText.trim(), client.voice);
          ttsPromises.push(ttsPromise);

          ttsPromise.then((ttsResult) => {
            if (ttsResult.success) {
              ttsChunks[currentIndex] = ttsResult.audioBuffer;
              
              // TTS chunk'ı frontend'e gönder (streaming)
              this.sendMessage(client.ws, {
                type: 'tts_chunk',
                audioBuffer: ttsResult.audioBuffer.toString('base64'),
                chunkIndex: currentIndex,
                mimeType: 'audio/mpeg'
              });
            }
            }).catch((error) => {
              // Sessizce geç
            });
        }
      });

      // AI response'u bekle
      const aiResult = await aiResultPromise;
      if (!aiResult || !aiResult.success) {
        throw new Error('AI yanıtı alınamadı');
      }

      // Tüm TTS chunk'larının tamamlanmasını bekle
      await Promise.all(ttsPromises);

      // Tamamlandı mesajı gönder
      this.sendMessage(client.ws, {
        type: 'response_complete',
        totalChunks: ttsChunks.length
      });

      } catch (error) {
        this.sendError(client.ws, error.message);
      }
  }

  // Mesaj gönder
  sendMessage(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  // Hata mesajı gönder
  sendError(ws, errorMessage) {
    this.sendMessage(ws, {
      type: 'error',
      message: errorMessage
    });
  }

  // Anlamsız/kısa chunk'ları filtrele
  filterMeaninglessChunks(text) {
    if (!text || text.trim().length === 0) {
      return null;
    }

    const trimmed = text.trim();
    const lowerText = trimmed.toLowerCase();

    // Çok kısa chunk'ları filtrele (2 karakterden az)
    if (trimmed.length < 3) {
      return null;
    }

    // Tek kelime ve yaygın kelimeleri filtrele (sadece gerçekten anlamsız olanlar)
    const words = trimmed.split(/\s+/);
    if (words.length === 1) {
      // Noktalama işaretini kaldır
      const wordWithoutPunctuation = lowerText.replace(/[.,!?;:]/g, '');
      
      // Sadece yaygın kelimeleri filtrele (cümle bağlamı olmadan anlamsız)
      const commonWords = ['you', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'for', 'of', 'in', 'on', 'at', 'by', 'with', 'from', 'as', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'must'];
      if (commonWords.includes(wordWithoutPunctuation)) {
        return null;
      }
      
      // Diğer tek kelime chunk'ları kabul et (birleştirilecek)
      // Örnek: "Yenilir." gibi chunk'lar birleştirilmeli
    }

    // "Thanks for watching" gibi yaygın ifadeleri filtrele (TTS feedback'inden gelebilir)
    const commonPhrases = [
      'thanks for watching',
      'thank you for watching',
      'thanks for watching!',
      'thank you for watching!',
      'thanks for watching.',
      'thank you for watching.'
    ];
    if (commonPhrases.includes(lowerText)) {
      return null;
    }

    // Sadece noktalama işaretlerinden oluşan chunk'ları filtrele
    const meaningfulText = trimmed.replace(/[.,!?;:\s]/g, '');
    if (meaningfulText.length < 3) {
      return null;
    }

    return trimmed;
  }
}

module.exports = new S2SWebSocketService();

