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
    try {
      console.log('🎤 STT: Audio buffer alındı, boyut:', audioBuffer.length, 'bytes');
      console.log('🎤 STT: Buffer tipi:', typeof audioBuffer);
      console.log('🎤 STT: Buffer constructor:', audioBuffer.constructor.name);
      
      // Buffer'ı doğrudan kullan - Node.js'de File constructor yok
      // OpenAI SDK'sı Buffer'ı kabul ediyor
      
      console.log('🎤 STT: Buffer bilgileri:', {
        length: audioBuffer.length,
        type: audioBuffer.constructor.name
      });

      console.log('🎤 STT: OpenAI APIye gönderiliyor...');
      
      // Buffer'ı geçici dosyaya yazalım (sync - daha hızlı, küçük dosyalar için)
      const tempFilePath = path.join(__dirname, '..', 'temp', `audio_${Date.now()}.m4a`);
      
      // Temp klasörü yoksa oluştur (sync - daha hızlı)
      const tempDir = path.dirname(tempFilePath);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // Buffer'ı dosyaya yaz (sync - küçük dosyalar için daha hızlı)
      fs.writeFileSync(tempFilePath, audioBuffer);
      console.log('🎤 STT: Geçici dosya oluşturuldu');
      
      // Dosyayı oku ve OpenAI'ye gönder (paralel olarak başlat)
      const audioFile = fs.createReadStream(tempFilePath);
      
      // OpenAI API'ye istek gönder (geçici dosya silme işlemini paralel yap)
      const transcriptionPromise = this.openai.audio.transcriptions.create({
        file: audioFile, // File stream kullan
        model: 'whisper-1', // En ucuz model
        language: 'tr', // Türkçe
        response_format: 'json' // JSON formatında al ki text property'si olsun
      });
      
      // Geçici dosyayı sil (async olarak, beklemeden devam et)
      setImmediate(() => {
        fs.unlink(tempFilePath, (err) => {
          if (err) console.error('❌ STT: Geçici dosya silinemedi:', err);
          else console.log('✅ STT: Geçici dosya silindi');
        });
      });
      
      // Transcription'ı bekle
      const transcription = await transcriptionPromise;

      console.log('🎤 STT: OpenAI yanıtı alındı:', transcription);

      // Whisper API'si translation.text property'si döndürüyor
      const text = transcription.text || '';
      console.log('🎤 STT: Çevrilen metin:', text);

      return {
        success: true,
        text: text
      };
    } catch (error) {
      console.error('❌ STT Error:', error);
      console.error('❌ STT Error Details:', {
        status: error.status,
        message: error.message,
        type: error.type,
        code: error.code
      });
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Text to AI Response - GPT-3.5-turbo (Streaming ile hızlandırıldı + callback)
  async getAIResponse(text, onFirstToken = null) {
    try {
      console.log('🤖 AI: Metin alındı:', text);
      console.log('🤖 AI: OpenAI Chat Completions API\'ye gönderiliyor (streaming)...');
      
      // Streaming kullanarak ilk token'ı daha hızlı al
      const stream = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo', // En ucuz model
        messages: [
          {
            role: 'system',
            content: 'You are a helpful AI assistant. You MUST ONLY respond in English. NEVER respond in Turkish or any other language. Always answer in English regardless of the language of the question. Provide concise, clear answers in English. Use short sentences. Be brief and to the point. Maximum 2-3 sentences per response.'
          },
          {
            role: 'user',
            content: text
          }
        ],
        max_tokens: 60, // Kısa ve öz yanıtlar için
        temperature: 0.5, // Daha deterministik
        presence_penalty: 0,
        frequency_penalty: 0,
        stream: true // Streaming açık - ilk token daha hızlı gelir
      });

      // Streaming response'u topla - ilk token geldiğinde callback çağır
      let fullResponse = '';
      let firstTokenReceived = false;
      
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          fullResponse += content;
          
          // İlk token geldiğinde callback çağır (TTS'i başlatmak için)
          if (!firstTokenReceived && onFirstToken) {
            firstTokenReceived = true;
            console.log('🚀 AI: İlk token alındı, callback çağrılıyor...');
            onFirstToken(fullResponse); // İlk kısım ile TTS'i başlat
          }
        }
      }

      console.log('🤖 AI: OpenAI yanıtı alındı (streaming):', fullResponse);
      console.log('🤖 AI: AI yanıtı:', fullResponse);

      return {
        success: true,
        response: fullResponse
      };
    } catch (error) {
      console.error('❌ AI Error:', error);
      console.error('❌ AI Error Details:', {
        status: error.status,
        message: error.message,
        type: error.type,
        code: error.code
      });
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Text to Speech - OpenAI TTS API (En ucuz model)
  async textToSpeech(text) {
    try {
      console.log('🔊 TTS: Metin alındı:', text);
      console.log('🔊 TTS: OpenAI TTS API\'ye gönderiliyor...');
      
      const mp3 = await this.openai.audio.speech.create({
        model: 'tts-1', // En ucuz TTS modeli
        voice: 'alloy', // En ucuz ses
        input: text,
        response_format: 'mp3',
        speed: 1.3 // %30 daha hızlı konuşma (TTS süresini daha da kısaltır)
      });

      console.log('🔊 TTS: OpenAI yanıtı alındı, buffer oluşturuluyor...');

      // TTS API'si ReadableStream döndürüyor, arrayBuffer() ile buffer'a çevir
      const buffer = Buffer.from(await mp3.arrayBuffer());
      console.log('🔊 TTS: Buffer oluşturuldu, boyut:', buffer.length, 'bytes');
      
      return {
        success: true,
        audioBuffer: buffer
      };
    } catch (error) {
      console.error('❌ TTS Error:', error);
      console.error('❌ TTS Error Details:', {
        status: error.status,
        message: error.message,
        type: error.type,
        code: error.code
      });
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Tam işlem akışı: Ses -> Metin -> AI -> Ses (Paralel işleme ile optimize edildi)
  async processVoiceToVoice(audioBuffer) {
    try {
      console.log('🚀 Voice to Voice process started...');
      console.log('🚀 Audio buffer boyutu:', audioBuffer.length, 'bytes');
      
      // 1. Ses -> Metin
      console.log('📝 Step 1: Converting speech to text...');
      const sttResult = await this.speechToText(audioBuffer);
      console.log('📝 STT Result:', sttResult);
      
      if (!sttResult.success) {
        console.log('❌ STT başarısız, işlem durduruluyor');
        return {
          success: false,
          error: 'Ses metne çevrilemedi: ' + sttResult.error
        };
      }

      // 2. Metin -> AI Yanıtı (Streaming + Paralel TTS başlatma)
      console.log('🤖 Step 2: Getting AI response (streaming + parallel TTS)...');
      
      // TTS'i paralel olarak başlatmak için promise
      let ttsPromise = null;
      let aiResponseText = '';
      
      // AI response streaming olarak gelirken, tamamlandığında TTS'i hemen başlat
      const aiResultPromise = this.getAIResponse(sttResult.text, (firstToken) => {
        // İlk token geldiğinde log (TTS'i tam response geldiğinde başlatacağız)
        console.log('🚀 AI: İlk token alındı:', firstToken);
      });
      
      // AI response'u al ve TTS'i paralel başlat
      const aiResult = await aiResultPromise;
      console.log('🤖 AI Result:', aiResult);
      
      if (!aiResult.success) {
        console.log('❌ AI başarısız, işlem durduruluyor');
        return {
          success: false,
          error: 'AI yanıtı alınamadı: ' + aiResult.error
        };
      }

      // 3. AI Yanıtı -> Ses (Hemen başlat - paralel işleme)
      console.log('🔊 Step 3: Converting text to speech (parallel)...');
      // TTS'i hemen başlat (await etmeden devam edebiliriz ama await ediyoruz)
      const ttsResult = await this.textToSpeech(aiResult.response);
      console.log('🔊 TTS Result:', ttsResult);
      
      if (!ttsResult.success) {
        console.log('❌ TTS başarısız, işlem durduruluyor');
        return {
          success: false,
          error: 'Ses oluşturulamadı: ' + ttsResult.error
        };
      }

      console.log('✅ Voice to Voice process completed successfully!');
      console.log('✅ Final result:', {
        transcription: sttResult.text,
        aiResponse: aiResult.response,
        audioBufferSize: ttsResult.audioBuffer.length
      });
      
      return {
        success: true,
        transcription: sttResult.text,
        aiResponse: aiResult.response,
        audioBuffer: ttsResult.audioBuffer
      };
    } catch (error) {
      console.error('💥 Voice to Voice Process Error:', error);
      console.error('💥 Error stack:', error.stack);
      return {
        success: false,
        error: 'İşlem sırasında hata oluştu: ' + error.message
      };
    }
  }
}

module.exports = new AIService();
