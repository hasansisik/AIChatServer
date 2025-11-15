const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

class AIService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 60000, // 60 saniye timeout (STT + AI + TTS için yeterli)
      maxRetries: 2 // Maksimum 2 retry
    });
  }

  // Speech to Text - Whisper API (En ucuz model)
  async speechToText(audioBuffer) {
    const startTime = Date.now();
    try {
      // Buffer'ı geçici dosyaya yazalım (sync - daha hızlı)
      const tempFilePath = path.join(__dirname, '..', 'temp', `audio_${Date.now()}.m4a`);
      const tempDir = path.dirname(tempFilePath);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      fs.writeFileSync(tempFilePath, audioBuffer);
      
      const audioFile = fs.createReadStream(tempFilePath);
      const transcriptionPromise = this.openai.audio.transcriptions.create({
        file: audioFile,
        model: 'whisper-1',
        // language parametresini kaldır (otomatik algılama daha hızlı olabilir)
        response_format: 'json',
        temperature: 0, // Deterministik = daha hızlı
        // prompt parametresini kaldır (daha hızlı)
      });
      
      // Geçici dosyayı sil (async)
      setImmediate(() => {
        fs.unlink(tempFilePath, () => {});
      });
      
      const transcription = await transcriptionPromise;
      const text = transcription.text || '';
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`STT süresi: ${duration}s`);

      return {
        success: true,
        text: text
      };
    } catch (error) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.error(`STT Error (${duration}s):`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Text to AI Response - GPT-4o-mini (Streaming with chunking)
  async getAIResponse(text, onChunk = null) {
    const startTime = Date.now();
    try {
      const stream = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Sen yardımcı bir AI asistanısın. Türkçe olarak kısa ve öz cevaplar ver. Maksimum 1-2 kısa cümle.'
          },
          {
            role: 'user',
            content: text
          }
        ],
        max_tokens: 50, // Kısa yanıtlar - hızlı chunk işleme
        temperature: 0,
        stream: true
      });

      let fullResponse = '';
      let buffer = '';
      let firstTokenTime = null;
      const punctuationMarks = ['.', '!', '?', ';'];
      
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          fullResponse += content;
          buffer += content;
          
          // İlk token zamanını kaydet
          if (!firstTokenTime) {
            firstTokenTime = Date.now();
          }
          
          // Noktalama işaretlerine göre chunk'lara böl
          const lastChar = buffer[buffer.length - 1];
          if (punctuationMarks.includes(lastChar) && buffer.trim().length > 0) {
            const chunkText = buffer.trim();
            if (chunkText.length > 0 && onChunk) {
              onChunk(chunkText);
            }
            buffer = ''; // Buffer'ı temizle
          }
        }
      }
      
      // Kalan buffer'ı da gönder (son chunk)
      if (buffer.trim().length > 0 && onChunk) {
        onChunk(buffer.trim());
      }

      const endTime = Date.now();
      const duration = ((endTime - startTime) / 1000).toFixed(2);
      console.log(`LLM süresi: ${duration}s`);

      return {
        success: true,
        response: fullResponse
      };
    } catch (error) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.error(`LLM Error (${duration}s):`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Text to Speech - OpenAI TTS API (En ucuz model)
  async textToSpeech(text, voice = 'alloy') {
    const startTime = Date.now();
    try {
      const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
      const selectedVoice = validVoices.includes(voice) ? voice : 'alloy';
      
      const mp3 = await this.openai.audio.speech.create({
        model: 'tts-1',
        voice: selectedVoice,
        input: text.trim(), // Boşlukları temizle
        response_format: 'mp3',
        speed: 1.0 // Normal konuşma hızı
      });

      const buffer = Buffer.from(await mp3.arrayBuffer());
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`TTS süresi: ${duration}s`);
      
      return {
        success: true,
        audioBuffer: buffer
      };
    } catch (error) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.error(`TTS Error (${duration}s):`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Tam işlem akışı: Ses -> Metin -> AI -> Ses (Akış Tabanlı Eşzamanlı İşleme)
  async processVoiceToVoice(audioBuffer, voice = 'alloy') {
    const totalStartTime = Date.now();
    try {
      // 1. Ses -> Metin (Tamamlanması gerekir)
      const sttResult = await this.speechToText(audioBuffer);
      if (!sttResult.success) {
        return {
          success: false,
          error: 'Ses metne çevrilemedi: ' + sttResult.error
        };
      }

      // Boş veya çok kısa metinleri filtrele (sadece gürültü veya sessizlik)
      const trimmedText = sttResult.text.trim();
      // Daha sıkı kontrol: minimum 5 karakter ve anlamlı kelimeler
      if (!trimmedText || trimmedText.length < 5) {
        console.log('⚠️ STT sonucu çok kısa veya boş, işlem atlanıyor:', trimmedText);
        return {
          success: false,
          error: 'Ses algılanamadı veya çok kısa'
        };
      }
      
      // Sadece noktalama işaretleri veya tekrarlayan karakterler varsa filtrele
      const meaningfulText = trimmedText.replace(/[.,!?;:\s]/g, '').trim();
      if (meaningfulText.length < 3) {
        return {
          success: false,
          error: 'Ses algılanamadı veya anlamsız'
        };
      }

      // 2. Metin -> AI Yanıtı (Streaming) + Paralel TTS Chunk'ları
      const ttsChunks = []; // Sıralı TTS chunk'ları (index ile)
      const ttsPromises = []; // Paralel TTS promise'leri
      let chunkIndex = 0;
      
      // AI response streaming olarak gelirken, chunk'lara böl ve TTS kuyruğuna ekle
      const aiResultPromise = this.getAIResponse(trimmedText, async (chunkText) => {
        // Her chunk'ı TTS kuyruğuna ekle ve paralel olarak işle
        if (chunkText.trim().length > 0) {
          const currentIndex = chunkIndex++;
          const ttsPromise = this.textToSpeech(chunkText.trim(), voice);
          ttsPromises.push(ttsPromise);
          
          // TTS tamamlandığında sıralı kuyruğa ekle
          ttsPromise.then((ttsResult) => {
            if (ttsResult.success) {
              ttsChunks[currentIndex] = ttsResult.audioBuffer;
            }
          }).catch((error) => {
          });
        }
      });
      
      // AI response'u bekle
      const aiResult = await aiResultPromise;
      if (!aiResult.success) {
        return {
          success: false,
          error: 'AI yanıtı alınamadı: ' + aiResult.error
        };
      }

      // Tüm TTS chunk'larının tamamlanmasını bekle
      await Promise.all(ttsPromises);
      
      // Tüm chunk'ları sırayla birleştir
      let combinedBuffer = null;
      const validChunks = ttsChunks.filter(chunk => chunk !== undefined);
      if (validChunks.length > 0) {
        // Tüm audio buffer'ları sırayla birleştir
        combinedBuffer = Buffer.concat(validChunks);
      } else {
        // Eğer chunk yoksa, tam response ile TTS yap
        const ttsResult = await this.textToSpeech(aiResult.response, voice);
        if (!ttsResult.success) {
          return {
            success: false,
            error: 'Ses oluşturulamadı: ' + ttsResult.error
          };
        }
        combinedBuffer = ttsResult.audioBuffer;
      }

      const totalDuration = ((Date.now() - totalStartTime) / 1000).toFixed(2);
      
      return {
        success: true,
        transcription: trimmedText,
        aiResponse: aiResult.response,
        audioBuffer: combinedBuffer
      };
    } catch (error) {
      const totalDuration = ((Date.now() - totalStartTime) / 1000).toFixed(2);
      return {
        success: false,
        error: 'İşlem sırasında hata oluştu: ' + error.message
      };
    }
  }
}

module.exports = new AIService();
