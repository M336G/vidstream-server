import { randomBytes } from "crypto";
import ffmpegBinary from "ffmpeg-static";
import ffprobeBinary from "ffprobe-static";
import { mkdir, rmdir, stat } from "node:fs/promises";
import { join, parse } from "node:path";

import { encoderArgs, maxFramerate, maxResolution, resolutions } from "./utilities";

// Simplified logging functions
const log = {
    // Log a fatal error
    fatal: async (message, fatal) => {
        console.error(`[FATAL] ${message}${fatal ? ` ${fatal}` : ""}`);
    },

    // Log an error
    error: async (message, error) => {
        console.error(`[ERROR] ${message}${error ? ` ${error}` : ""}`);
    },

    // Log a warning
    warn: async (message, warn) => {
        console.warn(`[WARN] ${message}${warn ? ` ${warn}` : ""}`);
    },

    // Log an info
    info: async (message, info) => {
        console.info(`[INFO] ${message}${info ? ` ${info}` : ""}`);
    },

    // Log a debug info
    debug: async (message, debug) => {
        console.debug(`[DEBUG] ${message}${debug ? ` ${debug}` : ""}`);
    },

    // Log a trace info
    trace: async (message, trace) => {
        console.trace(`[TRACE] ${message}${trace ? ` ${trace}` : ""}`);
    }
};

async function getClientIP(request) {
    const headers = request.headers

    // Start by checking if Cloudflare forwarded the IP
    let cfConnectingIP = headers.get("cf-connecting-ip");
    if (cfConnectingIP) return cfConnectingIP;

    // Check if NGINX X-Real-IP is supplied if not
    let xRealIP = headers.get("x-real-ip");
    if (xRealIP) return xRealIP;

    // If not then also check if NGINX has supplied X-Forwarded-For, and return the first IP of the list
    let xForwardedFor = headers.get("x-forwarded-for");
    if (xForwardedFor) return xForwardedFor.split(",")[0].trim();

    // If none of them are supplied, just supply the original address in the request
    return request.remoteAddr;
}

async function exists(path) {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

async function generateRandomString(length = 32) {
    const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const charsetLength = charset.length;
    const bytes = randomBytes(length);

    let auth = "";
    for (let i = 0; i < length; i++) {
        const index = bytes[i] % charsetLength;
        auth += charset[index];
    }
    return auth;
}

function parseFramerate(framerate) {
    if (!framerate) return 0;

    let fps;

    if (typeof framerate === "number") {
        fps = framerate;
    } else if (typeof framerate === "string") {
        if (framerate.includes("/")) {
            const [num, den] = framerate.split("/").map(Number);
            fps = den !== 0 ? num / den : 0;
        } else {
            fps = Number(framerate);
        }
    } else {
        return 0;
    }

    if (isNaN(fps) || fps === 0) return 0;

    if (Math.abs(fps - 240) < 5) return 240;
    else if (Math.abs(fps - 120) < 5) return 120;
    else if (Math.abs(fps - 60) < 10) return 60;
    else if (Math.abs(fps - 30) < 5) return 30;

    return fps;
}

async function getVideoMetadata(videoFilePath) {
    const proc = Bun.spawn({
        cmd: [
            ffprobeBinary.path,
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,avg_frame_rate",
            "-of", "json",
            videoFilePath
        ],
        stdout: "pipe",
        stderr: "pipe"
    });

    const exitCode = await proc.exited;
    const stdoutText = await new Response(proc.stdout).text();
    const stderrText = await new Response(proc.stderr).text();

    if (exitCode !== 0 || !stdoutText.trim()) {
        throw new Error(`ffprobe failed:\n${stderrText || "(no stderr output)"}`);
    }

    let output;
    try {
        output = JSON.parse(stdoutText);
    } catch (error) {
        throw new Error(`Failed to parse ffprobe JSON:\n${stdoutText}`);
    }

    const stream = output.streams?.[0];
    if (!stream) throw new Error("No video stream found");

    return {
        width: stream.width,
        height: stream.height,
        framerate: parseFramerate(stream.avg_frame_rate)
    };
}

async function getBestQuality(width, height) {
    const isPortrait = width < height;
    if (isPortrait) [width, height] = [height, width];

    let resolution;
    if (maxResolution >= resolutions["8k"] && width >= 7680 && height >= 4320)
        resolution = { width: 7680, height: 4320 };
    else if (maxResolution >= resolutions["4k"] && width >= 3840 && height >= 2160)
        resolution = { width: 3840, height: 2160 };
    else if (maxResolution >= resolutions["1440p"] && width >= 2560 && height >= 1440)
        resolution = { width: 2560, height: 1440 };
    else if (maxResolution >= resolutions["1080p"] && width >= 1920 && height >= 1080)
        resolution = { width: 1920, height: 1080 };
    else
        resolution = { width: 1280, height: 720 };

    if (isPortrait) return { width: resolution.height, height: resolution.width };
    else return resolution;
}

async function getBestFramerate(framerate) {
    if (maxFramerate >= 240 && framerate >= 240) return 240;
    else if (maxFramerate >= 120 && framerate >= 120) return 120;
    else if (maxFramerate >= 60 && framerate >= 60) return 60;
    else return 30;
}

async function getBestBitrate(width, height, framerate) {
    if (framerate >= 240) {
        if (width >= 7680 && height >= 4320) return "960000k";
        else if (width >= 3840 && height >= 2160) return "272000k";
        else if (width >= 2560 && height >= 1440) return "96000k";
        else if (width >= 1920 && height >= 1080) return "48000k";
        else return "30000k";
    } else if (framerate >= 120) {
        if (width >= 7680 && height >= 4320) return "480000k";
        else if (width >= 3840 && height >= 2160) return "136000k";
        else if (width >= 2560 && height >= 1440) return "48000k";
        else if (width >= 1920 && height >= 1080) return "24000k";
        else return "15000k";
    } else if (framerate >= 60) {
        if (width >= 7680 && height >= 4320) return "240000k";
        else if (width >= 3840 && height >= 2160) return "68000k";
        else if (width >= 2560 && height >= 1440) return "24000k";
        else if (width >= 1920 && height >= 1080) return "12000k";
        else return "7500k";
    } else {
        if (width >= 7680 && height >= 4320) return "160000k";
        else if (width >= 3840 && height >= 2160) return "45000k";
        else if (width >= 2560 && height >= 1440) return "16000k";
        else if (width >= 1920 && height >= 1080) return "8000k";
        else return "5000k";
    }
}

async function startStream(stream) {
    const { id, video, directory, width, height, fps, bitrate } = stream;

    await mkdir(directory, { recursive: true, force: true });

    const ffmpeg = Bun.spawn({
        cmd: [
            ffmpegBinary,
            "-loglevel", "error",
            "-re",
            "-i", video,
            "-vf", `scale=${width}x${height}`,
            "-r", `${fps}`,
            ...encoderArgs,
            "-b:v", `${bitrate}`,
            "-g", `${fps * 2}`,
            "-keyint_min", `${fps * 2}`,
            "-sc_threshold", "0",
            "-c:a", "aac",
            "-b:a", "128k",
            "-f", "hls",
            "-hls_time", "2",
            "-hls_list_size", "6",
            "-hls_flags", "delete_segments",
            join(directory, "index.m3u8"),
        ],
        stdout: "pipe",
        stderr: "pipe",
    });

    (async () => {
        const reader = ffmpeg.stderr.getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) {
                    const chunk = new TextDecoder().decode(value);
                    log.error(`[ffmpeg:${id}] ${chunk}`);
                }
            }
        } catch (error) {
            log.error(`[ffmpeg:${id} stderr read error]:`, error);
        } finally {
            reader.releaseLock();
        }
    })();

    ffmpeg.exited.then(async ({ code, signal }) => {
        if (code !== 0 && code !== undefined)
            log.error(`[ffmpeg ${id} exited with code ${code}, signal ${signal}]`);

        // 10s delay to let users finish the stream
        await new Promise(resolve => setTimeout(resolve, 10000));

        await rmdir(directory, { recursive: true, force: true });
        global.streams.delete(id);
        global.ffmpegProcesses.delete(id);
    }).catch(async (error) => {
        log.error(`[ffmpeg ${id} error]:`, error);

        await rmdir(directory, { recursive: true, force: true });
        global.streams.delete(id);
        global.ffmpegProcesses.delete(id);
    });

    global.ffmpegProcesses.set(id, ffmpeg);
}

async function killStream(id, streamPath = null) {
    // Try to kill ffmpeg and delete it from the ffmpegProcesses
    if (global.ffmpegProcesses.has(id)) {
        const ffmpeg = global.ffmpegProcesses.get(id)

        ffmpeg.kill("SIGKILL");
        global.ffmpegProcesses.delete(id);
    }

    // If streamPath is not supplied, try to get the path from the streams object
    if (!streamPath && global.streams.has(id)) {
        const stream = global.streams.get(id);
        streamPath = stream.directory;
    }

    // Try to delete the stream's directory and also from the streams object
    if (exists(streamPath)) await rmdir(streamPath, { recursive: true, force: true });
    if (global.streams.has(id)) global.streams.delete(id);
}

export {
    log,
    getClientIP,
    generateRandomString,
    getVideoMetadata,
    getBestQuality,
    getBestFramerate,
    getBestBitrate,
    startStream,
    killStream
}