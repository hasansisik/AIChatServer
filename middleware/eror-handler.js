const { StatusCodes } = require('http-status-codes');

const erorHandlerMiddleware = (err, req, res, next) => {

    let customError = {
        statusCode: err.statusCode || StatusCodes.INTERNAL_SERVER_ERROR,
        message: err.message || "Something went wrong try again later",
    };

    if (err.name === "ValidationError") {
        customError.message = Object.values(err.errors)
            .map((item) => item.message)
            .join(',');

        customError.statusCode = 400;
    }

    if (err.code && err.code === 11000) {
        customError.message = `Duplicate value entered for ${Object.keys(
            err.keyValue
        )} field, please choose another value`;

        customError.statusCode = 400;
    }

    if (err.name === "CastError") {
        customError.message = `No item found with id : ${err.value}`;

        customError.statusCode = 404;
    }

    // Handle mongoose connection errors
    if (err.name === "MongoNetworkError" || err.name === "MongoTimeoutError") {
        customError.message = "Veritabanı bağlantısında sorun yaşanıyor. Lütfen tekrar deneyin.";
        customError.statusCode = 503;
    }

    // Handle mongoose validation errors
    if (err.name === "MongooseError") {
        customError.message = "Veritabanı işleminde hata oluştu. Lütfen tekrar deneyin.";
        customError.statusCode = 500;
    }

    // Handle undefined mongoose errors
    if (err.message && err.message.includes("mongoose is not defined")) {
        customError.message = "Sunucu yapılandırmasında hata. Lütfen daha sonra tekrar deneyin.";
        customError.statusCode = 500;
    }

    return res.status(customError.statusCode).json({ message: customError.message });

};

module.exports = erorHandlerMiddleware;