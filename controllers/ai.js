const aiService = require('../services/ai.service');
const { StatusCodes } = require('http-status-codes');

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

    // AI servisini çağır
    console.log('🎯 Controller: AI servisine gönderiliyor...');
    const result = await aiService.processVoiceToVoice(audioBuffer);
    console.log('🎯 Controller: AI servis yanıtı:', result);

    if (!result.success) {
      console.log('❌ Controller: AI servis başarısız');
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: result.error
      });
    }

    // Başarılı yanıt
    console.log('✅ Controller: Başarılı yanıt hazırlanıyor');
    const audioUrl = `data:audio/mp3;base64,${result.audioBuffer.toString('base64')}`;
    console.log('✅ Controller: Audio URL oluşturuldu, boyut:', audioUrl.length, 'karakter');

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
    const { message } = req.body;

    if (!message || message.trim().length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: 'Mesaj boş olamaz'
      });
    }

    // AI servisini çağır
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
    const { text } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: 'Metin boş olamaz'
      });
    }

    // TTS servisini çağır
    const result = await aiService.textToSpeech(text);

    if (!result.success) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: result.error
      });
    }

    // Ses dosyasını base64 olarak döndür
    res.status(StatusCodes.OK).json({
      success: true,
      data: {
        audioUrl: `data:audio/mp3;base64,${result.audioBuffer.toString('base64')}`
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
