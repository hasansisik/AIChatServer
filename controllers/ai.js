const aiService = require('../services/ai.service');
const { StatusCodes } = require('http-status-codes');

// Ses kaydını işle ve sadece transkripsiyon döndür
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
    const result = await aiService.transcribe(audioBuffer);

    if (!result.success) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: result.error
      });
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`⏱️ Voice API: ${duration}s`);

    res.status(StatusCodes.OK).json({
      success: true,
      data: {
        transcription: result.transcription
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

module.exports = {
  processVoiceMessage
};
