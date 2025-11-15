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
      console.log(`⏱️ STT: ${duration}s`);

      return {
        success: true,
        text: text
      };
    } catch (error) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.error(`❌ STT Error (${duration}s):`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Text to AI Response - GPT-4o-mini (En hızlı model, tek token ile hızlı yanıt)
  async getAIResponse(text, onFirstToken = null) {
    const startTime = Date.now();
    try {
      // Streaming kullanarak ilk token'ı daha hızlı al
      const stream = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini', // En hızlı model
        messages: [
          {
            role: 'system',
            content: 'You are a helpful AI assistant. Respond ONLY in English. Be concise but complete.'
          },
          {
            role: 'user',
            content: text
          }
        ],
        max_tokens: 100, // Yeterli uzunlukta yanıtlar
        temperature: 0, // Çok deterministik - daha hızlı
        stream: true
      });

      // Streaming response'u topla - ilk token ve her chunk'ta callback çağır
      let fullResponse = '';
      let firstTokenReceived = false;
      let firstTokenTime = null;
      
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          fullResponse += content;
          
          // İlk token geldiğinde callback çağır
          if (!firstTokenReceived && onFirstToken) {
            firstTokenReceived = true;
            firstTokenTime = Date.now();
            onFirstToken(fullResponse);
          }
          // Her chunk'ta callback çağır (paralel TTS için)
          else if (onFirstToken) {
            onFirstToken(fullResponse);
          }
        }
      }

      const endTime = Date.now();
      const duration = ((endTime - startTime) / 1000).toFixed(2);
      const firstTokenDuration = firstTokenTime ? ((firstTokenTime - startTime) / 1000).toFixed(2) : 'N/A';
      console.log(`⏱️ AI: ${duration}s (ilk token: ${firstTokenDuration}s)`);

      return {
        success: true,
        response: fullResponse
      };
    } catch (error) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.error(`❌ AI Error (${duration}s):`, error.message);
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
      console.log(`⏱️ TTS: ${duration}s`);
      
      return {
        success: true,
        audioBuffer: buffer
      };
    } catch (error) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.error(`❌ TTS Error (${duration}s):`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Tam işlem akışı: Ses -> Metin -> AI -> Ses (Paralel işleme ile hızlandırıldı)
  async processVoiceToVoice(audioBuffer, voice = 'alloy') {
    const totalStartTime = Date.now();
    try {
      // 1. Ses -> Metin
      const sttResult = await this.speechToText(audioBuffer);
      if (!sttResult.success) {
        return {
          success: false,
          error: 'Ses metne çevrilemedi: ' + sttResult.error
        };
      }

      // 2. Metin -> AI Yanıtı (Streaming)
      const aiResult = await this.getAIResponse(sttResult.text);
      if (!aiResult.success) {
        return {
          success: false,
          error: 'AI yanıtı alınamadı: ' + aiResult.error
        };
      }

      // 3. AI Yanıtı -> Ses (Hemen başlat)
      const ttsResult = await this.textToSpeech(aiResult.response, voice);
      
      if (!ttsResult.success) {
        return {
          success: false,
          error: 'Ses oluşturulamadı: ' + ttsResult.error
        };
      }

      const totalDuration = ((Date.now() - totalStartTime) / 1000).toFixed(2);
      console.log(`⏱️ Toplam: ${totalDuration}s`);
      
      return {
        success: true,
        transcription: sttResult.text,
        aiResponse: aiResult.response,
        audioBuffer: ttsResult.audioBuffer
      };
    } catch (error) {
      const totalDuration = ((Date.now() - totalStartTime) / 1000).toFixed(2);
      console.error(`❌ Process Error (${totalDuration}s):`, error.message);
      return {
        success: false,
        error: 'İşlem sırasında hata oluştu: ' + error.message
      };
    }
  }
}

module.exports = new AIService();
