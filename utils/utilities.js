const Headers = {
    ping: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",

        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
        "Surrogate-Control": "no-store"
    },
    info: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS"
    },
    upload: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "*"
    },
    segment: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS"
    }
}

const supportedFileMimes = [
    "video/mp4",
    "video/webm",
    "video/x-matroska",
    "video/quicktime"
];

const resolutions = {
    "8k": 7680 * 4320,
    "4k": 3840 * 2160,
    "1440p": 2560 * 1440,
    "1080p": 1920 * 1080,
    "720p": 1280 * 720
};

const framerates = {
    "240fps": 240,
    "120fps": 120,
    "60fps": 60,
    "30fps": 30
};

const encoders = {
    "default": "libx264",
    "nvenc": "h264_nvenc",
    "amf": "h264_amf",
    "qsv": "h264_qsv"
};

const encoderPresets = [
    "ultrafast",
    "superfast",
    "veryfast",
    "faster",
    "fast",
    "medium",
    "slow",
    "slower",
    "veryslow"
];

const maxResolution = resolutions[process.env.MAX_RESOLUTION] || resolutions["1080p"];
const maxFramerate = framerates[process.env.MAX_FRAMERATE] || framerates["60fps"];

const encoderPreset = encoderPresets.includes(process.env.ENCODER_PRESET) ? process.env.ENCODER_PRESET : "veryfast";
const encoderArgs = process.env.ENCODER != encoders["default"] && process.env.ENCODER in encoders
    ? ["-c:v", encoders[process.env.ENCODER]]
    : ["-c:v", "libx264", "-preset", encoderPreset];

export {
    Headers,
    supportedFileMimes,
    resolutions,
    maxResolution,
    maxFramerate,
    encoderArgs
}