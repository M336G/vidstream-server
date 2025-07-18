import { rm } from "node:fs/promises";
import { mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { fileTypeFromBlob } from "file-type";

import { generateRandomString, getBestBitrate, getBestFramerate, getBestQuality, getVideoMetadata, startStream } from "./utils/functions.js";
import { Headers, supportedFileMimes } from "./utils/utilities.js";

const PORT = Number(process.env.PORT) || 4949;
const MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE) || 200 * 1024 * 1024; // 200 megabytes in bytes
const MAX_KEEP_ALIVE = Number(process.env.MAX_KEEP_ALIVE) || 1 * 60 * 60 * 1000; // 1 minute in milliseconds

global.STREAMS_DIR = join(__dirname, "streams");
// Just a cleanup
rmdirSync(global.STREAMS_DIR, { recursive: true, force: true })
mkdirSync(global.STREAMS_DIR, { recursive: true, force: true });

global.streams = new Map();
global.ffmpegProcesses = new Map();
let websocketClients = new Map();

const server = Bun.serve({
    port: PORT,
    maxUploadSize: MAX_UPLOAD_SIZE,
    development: process.argv.includes("--dev") || false,

    routes: {
        // Ping the server
        "/ping": {
            OPTIONS: async () => {
                return new Response(null, { status: 204, headers: Headers.ping });
            },
            GET: async () => {
                return Response.json({ success: true, timestamp: Date.now() }, { headers: Headers.ping });
            }
        },

        // Upload a video to be streamed
        "/upload": {
            OPTIONS: async () => {
                return new Response(null, { status: 204, headers: Headers.upload });
            },
            POST: async (req) => {
                const video = await req.blob();
                if (!video) return Response.json({ success: false, cause: "No video file provided!" }, { headers: Headers.upload, status: 400 });

                const fileType = await fileTypeFromBlob(video);
                if (!fileType) return Response.json({ success: false, cause: "Could not get your file's mime type" }, { headers: Headers.upload, status: 500 });
                if (!supportedFileMimes.includes(fileType.mime)) return Response.json({ success: false, cause: "Unsupported video file type!" }, { headers: Headers.upload, status: 422 });

                const id = await generateRandomString(32);
                const token = await generateRandomString(16);
                const videoPath = join(STREAMS_DIR, `${id}.${fileType.ext}`);

                await Bun.write(videoPath, video);

                const metadata = await getVideoMetadata(videoPath);
                const quality = await getBestQuality(metadata.width, metadata.height);
                const framerate = await getBestFramerate(metadata.framerate)
                const bitrate = await getBestBitrate(quality.width, quality.height, framerate);

                const now = Date.now();

                global.streams.set(id, {
                    id,
                    token,
                    state: "stopped",

                    width: quality.width,
                    height: quality.height,
                    fps: framerate,
                    bitrate: bitrate,

                    filePath: videoPath,
                    directoryPath: join(STREAMS_DIR, id),
                    keepAlive: now,
                    timestamp: now
                });

                return Response.json({ success: true, message: "Stream created!", id, token }, { headers: Headers.upload });
            }
        },

        "/:streamID/:segment": {
            OPTIONS: async () => {
                return new Response(null, { status: 204, headers: Headers.segment });
            },
            GET: async (req) => {
                const { streamID, segment } = req.params;

                if ((!segment.endsWith(".ts") && !segment.endsWith(".m3u8")) || !global.streams.has(streamID)) {
                    return new Response("Not Found", { headers: Headers.segment, status: 404 });
                }

                const streamPath = join(STREAMS_DIR, streamID, segment);
                if (!await Bun.file(streamPath).exists()) {
                    return new Response("Not Found", { headers: Headers.segment, status: 404 });
                }

                return new Response(Bun.file(streamPath).stream(), {
                    headers: {
                        ...Headers.segment,
                        "Content-Type": segment.endsWith(".ts") ? "video/MP2T" : "application/vnd.apple.mpegurl",
                        "Cache-Control": "no-cache"
                    }
                });
            }
        },

        // Upgrade to websocket
        "/ws": (req) => server.upgrade(req),

        // If the endpoint is not found
        "/*": Response.json({ success: false, cause: "Not Found" }, { headers: { "Access-Control-Allow-Origin": "*" }, status: 404 })
    },

    websocket: {
        maxPayloadLength: 2 * 1024, // 2 KB

        open(ws) {
            if (websocketClients.has(ws)) {
                const client = websocketClients.get(ws);
                ws.unsubscribe(client.stream);
                websocketClients.delete(ws);
            }
        },

        async message(ws, message) {
            let data;
            try {
                data = JSON.parse(message);
            } catch {
                return ws.send(JSON.stringify({ success: false, cause: "Invalid JSON" }));
            }

            if (!websocketClients.has(ws)) {
                if (!data.stream || !global.streams.has(data.stream)) {
                    ws.send(JSON.stringify({ success: false, cause: `Stream ${data.stream} doesn't exist!` }));
                    ws.close();
                    return;
                }

                const streamToken = global.streams.get(data.stream).token;

                ws.subscribe(data.stream);
                websocketClients.set(ws, {
                    stream: data.stream,
                    host: streamToken == data.token
                });
                ws.send(JSON.stringify({ success: true, message: `Now watching stream ${data.stream}!` }));
                return;
            }

            const client = websocketClients.get(ws);
            const stream = global.streams.get(client.stream);

            if (!data.stream || !global.streams.has(data.stream)) {
                ws.send(JSON.stringify({ success: false, cause: `Stream ${data.stream} doesn't exist!` }));
                ws.close();
                return;
            }

            if (data.type == "keepAlive") {
                if (stream.state != "started" || !global.ffmpegProcesses.has(client.stream)) return ws.send(JSON.stringify({ success: false, cause: "This stream hasn't even started yet!" }));

                stream.keepAlive = Date.now();
                global.streams.set(client.stream, stream);

                ws.send(JSON.stringify({ success: true, message: "Keep alive registered!" }));
            } else if (data.type == "start") {
                if (stream.state == "started" || global.ffmpegProcesses.has(client.stream)) return ws.send(JSON.stringify({ success: false, cause: "This stream has already started!" }));
                if (!client.host) return ws.send(JSON.stringify({ success: false, cause: "You're not the host!" }));

                await startStream(stream);

                client.host = true;
                websocketClients.set(ws, client);
                stream.state = "started";
                stream.keepAlive = Date.now();
                global.streams.set(client.stream, stream);

                ws.send(JSON.stringify({ success: true, message: "Stream started!" }));
            } else {
                ws.send(JSON.stringify({ success: false, cause: "This type doesn't exist!" }));
            }
        },

        close(ws) {
            if (websocketClients.has(ws)) {
                const client = websocketClients.get(ws);
                ws.unsubscribe(client.stream);
                websocketClients.delete(ws);
            }
        }
    },

    error(error) {
        console.error(`${error.stack}`);
        return Response.json({ success: false, cause: "Internal Server Error" }, { headers: { "Access-Control-Allow-Origin": "*" }, status: 500 });
    }
});

console.info(`Server is now running on ${server.url}!`);

setInterval(async () => {
    for (const [id, stream] of global.streams) {
        let viewers = 0;
        for (const [ws, client] of websocketClients) {
            if (client.stream == id) viewers++;
        }

        if (Date.now() - stream.keepAlive > MAX_KEEP_ALIVE) {
            const ffmpeg = global.ffmpegProcesses.get(id);
            ffmpeg.kill("SIGKILL");

            await rm(stream.filePath, { recursive: true, force: true });
            await rmdir(stream.directoryPath, { recursive: true, force: true });

            global.streams.delete(id);
            global.ffmpegProcesses.delete(id);
        }

        if (viewers > 0) {
            server.publish(id, JSON.stringify({
                success: true,
                type: "info",
                stream: id,
                state: stream.state,
                viewers
            }));
        }
    }
}, 1000); // Every second

setInterval(async () => {
    for (const [id, ffmpeg] of global.ffmpegProcesses) {
        if (!global.streams.has(id)) {
            try {
                if (!ffmpeg.killed) ffmpeg.kill("SIGKILL");
            } catch (error) {
                console.error(`Failed to kill ffmpeg for stream ${id}:`, error);
            }

            await rm(join(STREAMS_DIR, id), { recursive: true, force: true });
            global.ffmpegProcesses.delete(id);
        }
    }
}, 60_000); // Every minute