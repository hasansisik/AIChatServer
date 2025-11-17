const { SpeechClient } = require('@google-cloud/speech');
const OpenAI = require('openai');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');

class AIService {
  constructor() {
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
    this.speechClient = this.initializeSpeechClient();
    this.openai = this.initializeOpenAI();
  }

  initializeSpeechClient() {
    try {
      const speechOptions = {};
      const inlineCredential = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

      if (inlineCredential) {
        speechOptions.credentials = JSON.parse(inlineCredential);
      } else {
        const explicitPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_STT_CREDENTIALS_PATH;
        const localServicePath = path.resolve(__dirname, '..', 'service.json');
        const siblingAppPath = path.resolve(__dirname, '..', '..', 'AIChatApp', 'service.json');

        const candidatePaths = [explicitPath, localServicePath, siblingAppPath].filter(Boolean);
        const existingPath = candidatePaths.find((candidatePath) => fs.existsSync(candidatePath));

        if (existingPath) {
          speechOptions.keyFilename = existingPath;
          console.log(`🔐 Google STT credentials: ${existingPath}`);
        } else {
          console.warn('⚠️ Google STT credential dosyası bulunamadı. Varsayılan ADC kullanılacak.');
        }
      }

      return new SpeechClient(speechOptions);
    } catch (error) {
      console.error('❌ Google STT istemcisi oluşturulamadı:', error.message);
      return null;
    }
  }

  initializeOpenAI() {
    try {
      if (!process.env.OPENAI_API_KEY) {
        console.warn('⚠️ OPENAI_API_KEY tanımlı değil. LLM/TTS devre dışı.');
        return null;
      }
      return new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    } catch (error) {
      console.error('❌ OpenAI istemcisi oluşturulamadı:', error.message);
      return null;
    }
  }

  async convertAudioToLinear16(audioBuffer) {
    const tempDir = path.join(__dirname, '..', 'temp', 'stt');
    const inputPath = path.join(tempDir, `input_${Date.now()}.m4a`);
    const outputPath = path.join(tempDir, `output_${Date.now()}.raw`);

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    fs.writeFileSync(inputPath, audioBuffer);

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-f s16le',
          '-acodec pcm_s16le',
          '-ac 1',
          '-ar 16000'
        ])
        .on('end', () => {
          try {
            const convertedBuffer = fs.readFileSync(outputPath);
            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);
            resolve({ buffer: convertedBuffer, sampleRate: 16000 });
          } catch (error) {
            reject(error);
          }
        })
        .on('error', (error) => {
          try {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          } catch (cleanupError) {
            console.error('Cleanup error:', cleanupError.message);
          }
          reject(error);
        })
        .save(outputPath);
    });
  }

  createStreamingSession(onResult) {
    if (!this.speechClient) {
      return null;
    }

    const request = {
      config: {
        languageCode: process.env.GOOGLE_STT_LANGUAGE || 'tr-TR',
        alternativeLanguageCodes: (process.env.GOOGLE_STT_ALT_LANGUAGES || 'en-US')
          .split(',')
          .map((code) => code.trim())
          .filter(Boolean),
        enableAutomaticPunctuation: true,
        model: process.env.GOOGLE_STT_MODEL || 'latest_long',
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        audioChannelCount: 1
      },
      interimResults: true
    };

    const recognizeStream = this.speechClient.streamingRecognize(request)
      .on('data', (data) => {
        try {
          const result = data.results?.[0];
          const transcript = result?.alternatives?.[0]?.transcript?.trim();
          if (transcript) {
            onResult({
              text: transcript,
              isFinal: Boolean(result?.isFinal)
            });
          }
        } catch (error) {
          console.error('Streaming STT parse error:', error);
        }
      })
      .on('error', (error) => {
        console.error('Streaming STT error:', error);
        onResult({
          error: true,
          message: error.message
        });
      });

    let isClosed = false;
    recognizeStream.on('error', () => {
      isClosed = true;
    });
    recognizeStream.on('end', () => {
      isClosed = true;
    });

    return {
      writeChunk: async (audioBuffer) => {
        if (isClosed) {
          throw new Error('STT akışı kapandı');
        }
        const { buffer } = await this.convertAudioToLinear16(audioBuffer);
        recognizeStream.write(buffer);
      },
      finish: async () => {
        if (isClosed) {
          return;
        }
        isClosed = true;
        return new Promise((resolve) => {
          recognizeStream.once('end', resolve);
          recognizeStream.once('error', resolve);
          recognizeStream.end();
        });
      },
      cancel: () => {
        isClosed = true;
        recognizeStream.destroy();
      }
    };
  }

  async generateAssistantReply(userText) {
    if (!this.openai) {
      throw new Error('OpenAI istemcisi hazır değil');
    }

    const systemPrompt = process.env.LLM_SYSTEM_PROMPT || 'Sen sıcak kanlı bir arkadaşsın, kısa ve samimi cevaplar ver.';

    const llmStart = Date.now();
    const completion = await this.openai.chat.completions.create({
      model: process.env.LLM_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText }
      ],
      max_tokens: Number(process.env.LLM_MAX_TOKENS || 80),
      temperature: Number(process.env.LLM_TEMPERATURE || 0.6)
    });
    const llmDuration = Date.now() - llmStart;

    const replyText = completion.choices?.[0]?.message?.content?.trim();
    if (!replyText) {
      throw new Error('LLM boş cevap döndürdü');
    }
    console.log(`🤖 LLM süresi: ${llmDuration}ms`);
    return replyText;
  }

  async synthesizeSpeech(text, voice = 'alloy') {
    if (!this.openai) {
      throw new Error('OpenAI istemcisi hazır değil');
    }

    const ttsStart = Date.now();
    const response = await this.openai.audio.speech.create({
      model: process.env.TTS_MODEL || 'gpt-4o-mini-tts',
      voice: voice || 'alloy',
      input: text,
      format: 'mp3',
      speed: Number(process.env.TTS_SPEED || 1.2)
    });

    const arrayBuffer = await response.arrayBuffer();
    const duration = Date.now() - ttsStart;
    console.log(`🔊 TTS süresi: ${duration}ms`);
    return Buffer.from(arrayBuffer);
  }

  async generateAssistantReplyWithTTS(userText, voice = 'alloy') {
    const totalStart = Date.now();
    const replyText = await this.generateAssistantReply(userText);
    const audioBuffer = await this.synthesizeSpeech(replyText, voice);
    const totalDuration = Date.now() - totalStart;
    console.log(`⚡ LLM+TTS toplam: ${totalDuration}ms`);
    return {
      replyText,
      audioBuffer
    };
  }
}

module.exports = new AIService();
