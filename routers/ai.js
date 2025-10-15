const express = require('express');
const multer = require('multer');
const { processVoiceMessage, sendTextMessage, textToSpeech } = require('../controllers/ai');

const router = express.Router();

// Multer konfigürasyonu - ses dosyaları için
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Sadece ses dosyalarını kabul et
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Sadece ses dosyaları kabul edilir'), false);
    }
  }
});

// POST /v1/ai/voice - Ses kaydını işle ve AI yanıtı al
router.post('/voice', upload.single('audio'), processVoiceMessage);

// POST /v1/ai/text - Metin gönder ve AI yanıtı al
router.post('/text', sendTextMessage);

// POST /v1/ai/tts - Metni sese çevir
router.post('/tts', textToSpeech);

module.exports = router;
