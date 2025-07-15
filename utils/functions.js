import { randomBytes } from "crypto";
import ffmpegBinary from "ffmpeg-static";
import ffprobeBinary from "ffprobe-static";
import { mkdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";

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
    const { id, filePath, directoryPath, width, height, fps, bitrate } = stream;

    await mkdir(directoryPath, { recursive: true, force: true });

    const ffmpeg = Bun.spawn({
        cmd: [
            ffmpegBinary,
            "-loglevel", "error",
            "-i", filePath,
            "-vf", `scale=${width}x${height}`,
            "-r", `${fps}`,
            "-c:v", "libx264",
            "-b:v", `${bitrate}`,
            "-preset", "fast",
            "-g", `${fps * 2}`,
            "-keyint_min", `${fps * 2}`,
            "-sc_threshold", "0",
            "-c:a", "aac",
            "-b:a", "128k",
            "-f", "hls",
            "-hls_time", "2",
            "-hls_list_size", "6",
            "-hls_flags", "delete_segments",
            join(directoryPath, "index.m3u8"),
        ],
        stdout: "pipe",
        stderr: "pipe",
    });

    // Read ffmpeg stderr as a stream
    (async () => {
        const reader = ffmpeg.stderr.getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) {
                    const chunk = new TextDecoder().decode(value);
                    console.error(`[ffmpeg:${id}] ${chunk}`);
                }
            }
        } catch (error) {
            console.error(`[ffmpeg:${id} stderr read error]:`, error);
        } finally {
            reader.releaseLock();
        }
    })();

    ffmpeg.exited.then(async ({ code, signal }) => {
        if (code !== 0 && code !== undefined) {
            console.error(`[ffmpeg ${id} exited with code ${code}, signal ${signal}]`);
        } else {
            console.log(`[ffmpeg ${id} exited normally with code ${code}, signal ${signal}]`);
        }
        await rm(filePath, { force: true });
        await rmdir(directoryPath, { recursive: true, force: true });
        global.streams.delete(id);
        global.ffmpegProcesses.delete(id);
    }).catch(async (error) => {
        console.error(`[ffmpeg ${id} error]:`, error);
        await rm(filePath, { force: true });
        await rmdir(directoryPath, { recursive: true, force: true });
        global.streams.delete(id);
        global.ffmpegProcesses.delete(id);
    });


    global.ffmpegProcesses.set(id, ffmpeg);
}


export {
    getClientIP,
    generateRandomString,
    getVideoMetadata,
    getBestQuality,
    getBestFramerate,
    getBestBitrate,
    startStream
}