const aiService = require('../services/ai.service');
const { StatusCodes } = require('http-status-codes');
const fs = require('fs');
const path = require('path');

// Eski audio dosyalarını temizle (1 saatten eski dosyalar)
const cleanupOldAudioFiles = (publicDir) => {
  try {
    if (!fs.existsSync(publicDir)) return;
    
    const files = fs.readdirSync(publicDir);
    const now = Date.now();
    const oneHour = 60 * 60 * 1000; // 1 saat
    
    files.forEach(file => {
      const filePath = path.join(publicDir, file);
      const stats = fs.statSync(filePath);
      const fileAge = now - stats.mtimeMs;
      
      // 1 saatten eski dosyaları sil
      if (fileAge > oneHour) {
        fs.unlinkSync(filePath);
        console.log('🧹 Eski audio dosyası silindi:', file);
      }
    });
  } catch (error) {
    console.error('❌ Audio dosyası temizleme hatası:', error);
  }
};

// Ses kaydını işle ve AI yanıtı al
const processVoiceMessage = async (req, res) => {
  const startTime = Date.now();
  try {
    if (!req.file) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: 'Ses dosyası bulunamadı'
      });
    }

    const audioBuffer = req.file.buffer;
    const voice = req.body.voice || req.query.voice || 'alloy';
    const result = await aiService.processVoiceToVoice(audioBuffer, voice);

    if (!result.success) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: result.error
      });
    }

    // Public klasörü yoksa oluştur
    const publicDir = path.join(__dirname, '..', 'public', 'audio');
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }
    
    setImmediate(() => cleanupOldAudioFiles(publicDir));
    
    const fileName = `audio_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
    const filePath = path.join(publicDir, fileName);
    fs.writeFileSync(filePath, result.audioBuffer);
    
    const baseUrl = req.protocol + '://' + req.get('host');
    const audioUrl = `${baseUrl}/audio/${fileName}`;
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`⏱️ Voice API: ${duration}s`);

    res.status(StatusCodes.OK).json({
      success: true,
      data: {
        transcription: result.transcription,
        aiResponse: result.aiResponse,
        audioUrl: audioUrl
      }
    });

  } catch (error) {
    console.error('💥 Controller Error:', error);
    console.error('💥 Controller Error Stack:', error.stack);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: 'Ses işleme sırasında hata oluştu'
    });
  }
};

// Sadece metin gönder ve AI yanıtı al
const sendTextMessage = async (req, res) => {
  const startTime = Date.now();
  try {
    const { message, voice } = req.body;

    if (!message || message.trim().length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: 'Mesaj boş olamaz'
      });
    }
    
    const selectedVoice = voice || 'alloy';
    const result = await aiService.getAIResponse(message);

    if (!result.success) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: result.error
      });
    }
    
    const ttsResult = await aiService.textToSpeech(result.response, selectedVoice);

    if (!ttsResult.success) {
      return res.status(StatusCodes.OK).json({
        success: true,
        data: {
          aiResponse: result.response
        }
      });
    }

    const publicDir = path.join(__dirname, '..', 'public', 'audio');
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }
    
    setImmediate(() => cleanupOldAudioFiles(publicDir));
    
    const fileName = `tts_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
    const filePath = path.join(publicDir, fileName);
    fs.writeFileSync(filePath, ttsResult.audioBuffer);
    
    const baseUrl = req.protocol + '://' + req.get('host');
    const audioUrl = `${baseUrl}/audio/${fileName}`;
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`⏱️ Text API: ${duration}s`);

    // Başarılı yanıt - audioUrl ile birlikte
    res.status(StatusCodes.OK).json({
      success: true,
      data: {
        aiResponse: result.response,
        audioUrl: audioUrl
      }
    });

  } catch (error) {
    console.error('Text Message Process Error:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: 'Metin işleme sırasında hata oluştu'
    });
  }
};

// Metni sese çevir
const textToSpeech = async (req, res) => {
  try {
    const { text, voice } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: 'Metin boş olamaz'
      });
    }

    // Voice bilgisini al (varsayılan: alloy)
    const selectedVoice = voice || 'alloy';
    console.log('🎯 TTS Controller: Voice seçildi:', selectedVoice);

    // TTS servisini çağır
    const result = await aiService.textToSpeech(text, selectedVoice);

    if (!result.success) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: result.error
      });
    }

    // Ses dosyasını kaydet ve URL döndür (base64 yerine, çok daha hızlı)
    // Public klasörü yoksa oluştur
    const publicDir = path.join(__dirname, '..', 'public', 'audio');
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }
    
    // Eski dosyaları temizle (async olarak, beklemeden devam et)
    setImmediate(() => cleanupOldAudioFiles(publicDir));
    
    // Unique dosya adı oluştur
    const fileName = `tts_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
    const filePath = path.join(publicDir, fileName);
    
    // Audio buffer'ı dosyaya kaydet
    fs.writeFileSync(filePath, result.audioBuffer);
    console.log('✅ TTS Controller: Audio dosyası kaydedildi:', fileName);
    
    // URL oluştur
    const baseUrl = req.protocol + '://' + req.get('host');
    const audioUrl = `${baseUrl}/audio/${fileName}`;
    
    res.status(StatusCodes.OK).json({
      success: true,
      data: {
        audioUrl: audioUrl
      }
    });

  } catch (error) {
    console.error('Text to Speech Error:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: 'Metin sese çevirme sırasında hata oluştu'
    });
  }
};

module.exports = {
  processVoiceMessage,
  sendTextMessage,
  textToSpeech
};
