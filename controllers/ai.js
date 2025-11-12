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
  try {
    console.log('🎯 Controller: Voice message işlemi başladı');
    console.log('🎯 Controller: Request headers:', req.headers);
    console.log('🎯 Controller: Request file:', req.file ? {
      fieldname: req.file.fieldname,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    } : 'No file');

    if (!req.file) {
      console.log('❌ Controller: Ses dosyası bulunamadı');
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: 'Ses dosyası bulunamadı'
      });
    }

    // Ses dosyasını buffer'a çevir
    const audioBuffer = req.file.buffer;
    console.log('🎯 Controller: Audio buffer alındı, boyut:', audioBuffer.length, 'bytes');

    // Voice bilgisini al (body'den veya query'den)
    const voice = req.body.voice || req.query.voice || 'alloy';
    console.log('🎯 Controller: Voice seçildi:', voice);

    // AI servisini çağır
    console.log('🎯 Controller: AI servisine gönderiliyor...');
    const result = await aiService.processVoiceToVoice(audioBuffer, voice);
    console.log('🎯 Controller: AI servis yanıtı:', result);

    if (!result.success) {
      console.log('❌ Controller: AI servis başarısız');
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: result.error
      });
    }

    // Başarılı yanıt - Audio dosyasını kaydet ve URL döndür
    console.log('✅ Controller: Başarılı yanıt hazırlanıyor');
    
    // Public klasörü yoksa oluştur
    const publicDir = path.join(__dirname, '..', 'public', 'audio');
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }
    
    // Eski dosyaları temizle (async olarak, beklemeden devam et)
    setImmediate(() => cleanupOldAudioFiles(publicDir));
    
    // Unique dosya adı oluştur
    const fileName = `audio_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
    const filePath = path.join(publicDir, fileName);
    
    // Audio buffer'ı dosyaya kaydet (sync - hızlı)
    fs.writeFileSync(filePath, result.audioBuffer);
    console.log('✅ Controller: Audio dosyası kaydedildi:', fileName);
    
    // URL oluştur
    const baseUrl = req.protocol + '://' + req.get('host');
    const audioUrl = `${baseUrl}/audio/${fileName}`;
    console.log('✅ Controller: Audio URL oluşturuldu:', audioUrl);

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
  try {
    const { message, voice } = req.body;

    if (!message || message.trim().length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: 'Mesaj boş olamaz'
      });
    }

    // AI servisini çağır (voice bilgisi text mesajında TTS için kullanılmaz, sadece response döner)
    const result = await aiService.getAIResponse(message);

    if (!result.success) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: result.error
      });
    }

    // Başarılı yanıt
    res.status(StatusCodes.OK).json({
      success: true,
      data: {
        aiResponse: result.response
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
