import { randomBytes } from "crypto";
import ffmpegBinary from "ffmpeg-static";
import ffprobeBinary from "ffprobe-static";
import { mkdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";

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

async function getVideoMetadata(videoFilePath) {
    const proc = Bun.spawn({
        cmd: [
            ffprobeBinary.path,
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,r_frame_rate",
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
    } catch (e) {
        throw new Error(`Failed to parse ffprobe JSON:\n${stdoutText}`);
    }

    const stream = output.streams?.[0];
    if (!stream) throw new Error("No video stream found");

    const [num, denom] = stream.r_frame_rate.split("/").map(Number);
    const framerate = denom ? num / denom : 30;

    return {
        width: stream.width,
        height: stream.height,
        framerate
    };
}

async function getBestQuality(width, height) {
    if (width >= 3840 && height >= 2160) return { width: 3840, height: 2160 };
    else if (width >= 2560 && height >= 1440) return { width: 2560, height: 1440 };
    else if (width >= 1920 && height >= 1080) return { width: 1920, height: 1080 };
    else return { width: 1280, height: 720 };
}

async function getBestFramerate(framerate) {
    if (framerate >= 60) return 60;
    else return 30
}

async function getBestBitrate(width, height, framerate) {
    if (framerate > 30) {
        if (width >= 3840 && height >= 2160) return "68000k";
        else if (width >= 2560 && height >= 1440) return "24000k";
        else if (width >= 1920 && height >= 1080) return "12000k";
        else return "7500k";
    } else {
        if (width >= 3840 && height >= 2160) return "45000k";
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
            "-c:v", "libx264",
            "-b:v", `${bitrate}`,
            "-preset", "veryfast",
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
    generateRandomString,
    getVideoMetadata,
    getBestQuality,
    getBestFramerate,
    getBestBitrate,
    startStream,
    killStream
}