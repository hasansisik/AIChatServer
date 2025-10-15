const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

class AIService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 10000, // 10 saniye timeout
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
      
      // Buffer'ı geçici dosyaya yazalım
      const tempFilePath = path.join(__dirname, '..', 'temp', `audio_${Date.now()}.m4a`);
      
      // Temp klasörü yoksa oluştur
      const tempDir = path.dirname(tempFilePath);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // Buffer'ı dosyaya yaz
      fs.writeFileSync(tempFilePath, audioBuffer);
      console.log('🎤 STT: Geçici dosya oluşturuldu:', tempFilePath);
      
      // Dosyayı oku ve OpenAI'ye gönder
      const audioFile = fs.createReadStream(tempFilePath);
      
      const transcription = await this.openai.audio.transcriptions.create({
        file: audioFile, // File stream kullan
        model: 'whisper-1', // En ucuz model
        language: 'tr', // Türkçe
        response_format: 'json' // JSON formatında al ki text property'si olsun
      });
      
      // Geçici dosyayı sil
      fs.unlinkSync(tempFilePath);
      console.log('🎤 STT: Geçici dosya silindi');

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

  // Text to AI Response - GPT-3.5-turbo (En ucuz model)
  async getAIResponse(text) {
    try {
      console.log('🤖 AI: Metin alındı:', text);
      console.log('🤖 AI: OpenAI Chat Completions API\'ye gönderiliyor...');
      
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo', // En ucuz model
        messages: [
          {
            role: 'system',
            content: 'Sen yardımcı bir AI asistanısın. Kısa, net ve Türkçe cevaplar ver. Maksimum 50 kelime kullan.'
          },
          {
            role: 'user',
            content: text
          }
        ],
        max_tokens: 80, // Daha kısa yanıtlar için
        temperature: 0.5, // Daha deterministik
        presence_penalty: 0,
        frequency_penalty: 0,
        stream: false // Streaming kapalı
      });

      console.log('🤖 AI: OpenAI yanıtı alındı:', completion);

      // Chat Completions API'si choices[0].message.content döndürüyor
      const responseText = completion.choices[0].message.content || '';
      console.log('🤖 AI: AI yanıtı:', responseText);

      return {
        success: true,
        response: responseText
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
        speed: 1 // %20 daha hızlı konuşma
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

  // Tam işlem akışı: Ses -> Metin -> AI -> Ses
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

      // 2. Metin -> AI Yanıtı
      console.log('🤖 Step 2: Getting AI response...');
      const aiResult = await this.getAIResponse(sttResult.text);
      console.log('🤖 AI Result:', aiResult);
      
      if (!aiResult.success) {
        console.log('❌ AI başarısız, işlem durduruluyor');
        return {
          success: false,
          error: 'AI yanıtı alınamadı: ' + aiResult.error
        };
      }

      // 3. AI Yanıtı -> Ses
      console.log('🔊 Step 3: Converting text to speech...');
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
