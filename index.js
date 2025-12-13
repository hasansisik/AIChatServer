require('dotenv').config();
require('express-async-errors');
//express
const express = require('express');
const app = express();

// rest of the packages
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');

//database
const connectDB = require('./config/connectDB');

//routers
const authRouter = require('./routers/auth');
const couponRouter = require('./routers/coupon');
const onboardingRouter = require('./routers/onboarding');
const settingsRouter = require('./routers/settings');
const translateRouter = require('./routers/translate');

//midlleware
const notFoundMiddleware = require('./middleware/not-found')
const erorHandlerMiddleware = require('./middleware/eror-handler')

//app
const corsOptions = {
  origin: true,
  credentials: true,
  exposedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(helmet());
app.use(mongoSanitize());

app.use(morgan('tiny'));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser(process.env.JWT_SECRET_KEY));

app.use(express.static('./public'));

app.use(express.urlencoded({ extended: true }));

app.use('/v1/auth', authRouter);
app.use('/v1/coupons', couponRouter);
app.use('/v1/onboardings', onboardingRouter);
app.use('/v1/settings', settingsRouter);
app.use('/v1/translate', translateRouter);

app.use(notFoundMiddleware);
app.use(erorHandlerMiddleware);

const http = require('http');
const s2sWebSocketService = require('./services/s2sWebSocket.service');

const port = process.env.PORT || 5001

const start = async () => {
    try {
        await connectDB(process.env.MONGO_URL)
        
        // HTTP server oluştur (WebSocket için gerekli)
        const server = http.createServer(app);
        
        // S2S WebSocket server'ı başlat
        s2sWebSocketService.initialize(server);
        
        server.listen(port,
            console.log(`MongoDb Connection Successful,App started on port ${port} : ${process.env.NODE_ENV}`),
        );
    } catch (error) {
        console.log(error);
    }
};

start();