import { mkdirSync, rmdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileTypeFromBlob } from "file-type";

import { log, generateRandomString, getBestBitrate, getBestFramerate, getBestQuality, getVideoMetadata, killStream, startStream } from "./utils/functions.js";
import { Headers, supportedFileMimes } from "./utils/utilities.js";

// Get environment variables
const PORT = Number(process.env.PORT) || 4949;
const MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE) ? Number(process.env.MAX_UPLOAD_SIZE) * 1024 * 1024 : 200 * 1024 * 1024; // 200 megabytes in bytes
const MAX_KEEP_ALIVE = Number(process.env.MAX_KEEP_ALIVE) ? Number(process.env.MAX_KEEP_ALIVE) * 60 * 60 * 1000 : 1 * 60 * 60 * 1000; // 1 minute in milliseconds

// Path to the streams directory
const streamsDirectory = join(__dirname, "streams");

// Cleanup just in case
if (existsSync(streamsDirectory)) rmdirSync(streamsDirectory, { recursive: true, force: true })
if (!existsSync(streamsDirectory)) mkdirSync(streamsDirectory, { recursive: true, force: true });

global.streams = new Map();
global.ffmpegProcesses = new Map();
let websocketClients = new Map();

const server = Bun.serve({
    port: PORT,
    maxUploadSize: MAX_UPLOAD_SIZE,
    development: process.argv.includes("--dev") || false,

    routes: {
        // Redirect from / to /info
        "/": Response.redirect("/info", 307),

        // Ping the server
        "/ping": {
            OPTIONS: async () => {
                return new Response(null, { status: 204, headers: Headers.ping });
            },
            GET: async () => {
                return Response.json({ success: true, timestamp: Date.now() }, { headers: Headers.ping });
            }
        },

        // Get info about the server
        "/info": {
            OPTIONS: async () => {
                return new Response(null, { status: 204, headers: Headers.info });
            },
            GET: async () => {
                return Response.json({
                    success: true,
                    maxUploadSize: MAX_UPLOAD_SIZE,
                    maxKeepAlive: MAX_KEEP_ALIVE,
                }, { headers: Headers.info });
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

                // Get mime type and check if it's supported
                const fileType = await fileTypeFromBlob(video);
                if (!fileType) return Response.json({ success: false, cause: "Could not get your file's mime type" }, { headers: Headers.upload, status: 500 });
                if (!supportedFileMimes.includes(fileType.mime)) return Response.json({ success: false, cause: "Unsupported video file type!" }, { headers: Headers.upload, status: 422 });

                const id = await generateRandomString(32);
                const token = await generateRandomString(16);

                const directoryPath = join(streamsDirectory, id); // This is where all files related to that video will be stored
                const videoPath = join(directoryPath, `video.${fileType.ext}`); // And here, the actual video

                await Bun.write(videoPath, video); // Write the file

                // Get all the metadata for ffmpeg
                const metadata = await getVideoMetadata(videoPath);
                const quality = await getBestQuality(metadata.width, metadata.height);
                const framerate = await getBestFramerate(metadata.framerate)
                const bitrate = await getBestBitrate(quality.width, quality.height, framerate);

                const now = Date.now();

                // Create the key in the streams object
                global.streams.set(id, {
                    id,
                    token,
                    state: "stopped",

                    width: quality.width,
                    height: quality.height,
                    fps: framerate,
                    bitrate: bitrate,

                    directory: directoryPath,
                    video: videoPath,

                    keepAlive: now,
                    timestamp: now
                });

                return Response.json({ success: true, message: "Stream created!", id, token }, { headers: Headers.upload });
            }
        },

        // Get segments for a stream
        "/:streamID/:segment": {
            OPTIONS: async () => {
                return new Response(null, { status: 204, headers: Headers.segment });
            },
            GET: async (req) => {
                const { streamID, segment } = req.params;

                // Prevent client from accessing other files
                if ((!segment.endsWith(".ts") && !segment.endsWith(".m3u8")) || !global.streams.has(streamID)) {
                    return new Response("Not Found", { headers: Headers.segment, status: 404 });
                }

                // Try to get the segment
                const streamPath = join(streamsDirectory, streamID, segment);
                if (!await Bun.file(streamPath).exists()) {
                    return new Response("Not Found", { headers: Headers.segment, status: 404 });
                }

                // Return the segment
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

        // Upon entering the websocket, unsubscribe the client if it
        // was in the websocketClients object (and delete it from there)
        open(ws) {
            if (websocketClients.has(ws)) {
                const client = websocketClients.get(ws);
                ws.unsubscribe(client.stream);
                websocketClients.delete(ws);
            }
        },

        // Handle the different messages sent by the client
        async message(ws, message) {
            let data;
            try {
                data = JSON.parse(message);
            } catch {
                return ws.send(JSON.stringify({ success: false, type: data.type, cause: "Invalid JSON" }));
            }

            // Check if the client is even in the object
            if (!websocketClients.has(ws)) {
                // Check if the client specified a stream or if
                // he's trying to watch a stream that doesn't exist
                if (!data.stream || !global.streams.has(data.stream)) {
                    ws.send(JSON.stringify({ success: false, type: data.type, cause: `Stream ${data.stream} doesn't exist!` }));
                    
                    ws.close();
                    return;
                }

                // Get the stream's token
                const streamToken = global.streams.get(data.stream).token;

                // Subscribe the client so that he can get information
                // and add him to the websocketClients object
                ws.subscribe(data.stream);
                websocketClients.set(ws, {
                    stream: data.stream,
                    host: streamToken == data.token
                });
                
                ws.send(JSON.stringify({ success: true, type: data.type, message: `Now watching stream ${data.stream}!` }));
                return;
            }

            // If the client is in the object, just get them here
            const client = websocketClients.get(ws);
            const stream = global.streams.get(client.stream);

            // Check if the stream they watch still exists
            if (!data.stream || !global.streams.has(data.stream)) {
                ws.send(JSON.stringify({ success: false, type: data.type, cause: `Stream ${data.stream} doesn't exist!` }));
                
                ws.close();
                return;
            }

            // Handle the client's request type
            switch (data.type) {
                case "start": // Start the stream
                    if (stream.state == "started" || global.ffmpegProcesses.has(client.stream))
                        return ws.send(JSON.stringify({ success: false, type: data.type, cause: "This stream has already started!" }));
                    if (!client.host)
                        return ws.send(JSON.stringify({ success: false, type: data.type, cause: "You're not the host!" }));

                    await startStream(stream);

                    // Set the stream's state to "started" and update the keep alive
                    stream.state = "started";
                    stream.keepAlive = Date.now();
                    global.streams.set(client.stream, stream);

                    ws.send(JSON.stringify({ success: true, type: data.type, message: "Stream started!" }));
                    break;
                case "keepAlive": // Update the stream's keep alive
                    if (stream.state != "started" || !global.ffmpegProcesses.has(client.stream))
                        return ws.send(JSON.stringify({ success: false, type: data.type, cause: "This stream hasn't even started yet!" }));

                    stream.keepAlive = Date.now();
                    global.streams.set(client.stream, stream);

                    ws.send(JSON.stringify({ success: true, type: data.type, message: "Keep alive registered!" }));
                    break;

                /*case "stop": // Stop a stream entirely
                    if (!client.host)
                        return ws.send(JSON.stringify({ success: false, type: data.type, cause: "You're not the host!" }));

                    await killStream(client.stream, stream.directory);

                    ws.send(JSON.stringify({ success: true, type: data.type, message: "Stream stopped!" }));
                    ws.close();
                    break;*/
                default:
                    ws.send(JSON.stringify({ success: false, type: data.type, cause: "This type doesn't exist!" }));
            }
        },

        // Upon closing a connection to the websocket, unsubscribe the client
        // and delete it from the websocketClients object if it's there
        close(ws) {
            if (websocketClients.has(ws)) {
                const client = websocketClients.get(ws);
                ws.unsubscribe(client.stream);
                websocketClients.delete(ws);
            }
        }
    },

    error(error) {
        log.error(`${error.stack}`);
        return Response.json({ success: false, cause: "Internal Server Error" }, { headers: { "Access-Control-Allow-Origin": "*" }, status: 500 });
    }
});

log.info(`Server is now running on ${server.url}!`);

// Check if any keep alive is expired and send info about ongoing streams
setInterval(async () => {
    for (const [id, stream] of global.streams) {
        let viewers = 0;

        // Count viewers
        for (const [ws, client] of websocketClients) {
            if (client.stream == id) viewers++;
        }

        // If the stream has been inactive for more time than the allowed keep alive, delete it
        if (Date.now() - stream.keepAlive > MAX_KEEP_ALIVE)
            await killStream(global.ffmpegProcesses.get(id), stream.directory);

        // Publish info to the viewers of that stream if there are people watching
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

// Check if ffmpegProcesses exists in the stream object
setInterval(async () => {
    for (const [id, ffmpeg] of global.ffmpegProcesses) {
        if (!global.streams.has(id)) {
            try {
                if (!ffmpeg.killed) await killStream(id, join(streamsDirectory, id));
                else global.ffmpegProcesses.delete(id); // Just not deleted from the object for some reason..?
            } catch (error) {
                log.error(`Failed to kill ffmpeg for stream ${id}:`, error.stack);
            }
        }
    }
}, 60_000); // Every minute

process.on("unhandledRejection", async (reason, promise) => {
    await log.fatal(reason.stack || reason);
    await server.stop(); // Stop the webserver
    for (const [id, ffmpeg] of global.ffmpegProcesses) { // Let's NOT keep ongoing ffmpeg processes
        if (!ffmpeg.killed) await killStream(id, join(streamsDirectory, id));
    }
    process.exit(1); // Exit the program
});

process.on("uncaughtException", async (error) => {
    await log.fatal(error.stack || error);
    await server.stop(); // Stop the webserver
    for (const [id, ffmpeg] of global.ffmpegProcesses) { // Let's NOT keep ongoing ffmpeg processes
        if (!ffmpeg.killed) await killStream(id, join(streamsDirectory, id));
    }
    process.exit(1); // Exit the program
});