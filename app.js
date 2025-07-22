import { mkdirSync, rmdirSync, existsSync, createWriteStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileTypeFromBuffer } from "file-type";

import { log, generateRandomString, getBestBitrate, getBestFramerate, getBestQuality, getVideoMetadata, killStream, startStream, getClientIP } from "./utils/functions.js";
import { Headers, supportedFileMimes } from "./utils/utilities.js";
import { RegexCheck } from "./utils/security.js";

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
    maxRequestBodySize: Number.MAX_SAFE_INTEGER, // i'd rather handle it myself
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
                const MAX_PROBE_BYTES = 4100; // First 4 KB of the file for type detection
                const id = await generateRandomString(32);
                const token = await generateRandomString(16);
                const directoryPath = join(streamsDirectory, id);

                await mkdir(directoryPath, { recursive: true });

                const tempPath = join(directoryPath, "video.tmp");
                const fileStream = createWriteStream(tempPath);
                const reader = req.body?.getReader();

                if (!reader) 
                    return Response.json({ success: false, cause: "No readable stream!" }, { status: 400, headers: Headers.upload });

                let totalBytes = 0;
                let probeBuffer = Buffer.alloc(0);
                let fileType;
                let done = false;

                while (!done) {
                    const { value, done: streamDone } = await reader.read();
                    if (value) {
                        totalBytes += value.length;
                        
                        if (totalBytes > MAX_UPLOAD_SIZE) {
                            fileStream.destroy();
                            return Response.json({ success: false, cause: "File exceeds max upload size!" }, { status: 413, headers: Headers.upload });
                        }

                        if (probeBuffer.length < MAX_PROBE_BYTES) {
                            probeBuffer = Buffer.concat([probeBuffer, Buffer.from(value)]);
                            if (probeBuffer.length > MAX_PROBE_BYTES) probeBuffer = probeBuffer.slice(0, MAX_PROBE_BYTES);
                        }

                        if (!fileType && probeBuffer.length >= MAX_PROBE_BYTES) {
                            const type = await fileTypeFromBuffer(probeBuffer);
                            if (type) fileType = type;
                        }

                        fileStream.write(Buffer.from(value));
                    }
                    done = streamDone;
                }

                fileStream.end();

                if (!fileType) fileType = await fileTypeFromBuffer(probeBuffer);

                if (!fileType || !supportedFileMimes.includes(fileType.mime))
                    return Response.json({ success: false, cause: "Unsupported or unknown file type!" }, { status: 422, headers: Headers.upload });

                const finalVideoPath = join(directoryPath, `video.${fileType.ext}`);
                await rename(tempPath, finalVideoPath);

                const metadata = await getVideoMetadata(finalVideoPath);

                const quality = await getBestQuality(metadata.width, metadata.height);
                const framerate = await getBestFramerate(metadata.framerate);
                const bitrate = await getBestBitrate(quality.width, quality.height, framerate);
                
                const now = Date.now();

                global.streams.set(id, {
                    id, token, state: "stopped",
                    width: quality.width,
                    height: quality.height,
                    fps: framerate,
                    bitrate,
                    directory: directoryPath,
                    video: finalVideoPath,
                    keepAlive: now,
                    timestamp: now
                });

                console.log(`[Stream] New stream:\n- ID: ${id}\n- Quality: ${quality.width}x${quality.height}\n- FPS: ${framerate}\n- Bitrate: ${bitrate}bps\n- Size: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

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
                if ((!segment.endsWith(".ts") && !segment.endsWith(".m3u8")) || !global.streams.has(streamID))
                    return new Response("Not Found", { headers: Headers.segment, status: 404 });

                // Try to get the segment
                const streamPath = join(streamsDirectory, streamID, segment);
                if (!await Bun.file(streamPath).exists())
                    return new Response("Not Found", { headers: Headers.segment, status: 404 });

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
        "/ws": async (req) => {
            return server.upgrade(req, { data: { ip: await getClientIP(req) } });
        },

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

            // Check if a stream ID's been supplied
            if (!data.stream) {
                ws.send(JSON.stringify({ success: false, type: data.type, cause: `No stream supplied!` }));

                ws.close();
                return;
            }

            // Check if the client is even in the object
            if (!websocketClients.has(ws)) {
                // Check if the client is trying to watch a stream that doesn't exist
                if (!data.stream || !global.streams.has(data.stream)) {
                    ws.send(JSON.stringify({ success: false, type: data.type, cause: `Stream ${data.stream} doesn't exist!` }));

                    ws.close();
                    return;
                }

                // Check if the client supplied a username
                if (!data.username) {
                    ws.send(JSON.stringify({ success: false, type: data.type, cause: "No username supplied!" }));

                    ws.close();
                    return;
                }
                // Check if the username supplied is valid
                if (!await RegexCheck.username(data.username)) {
                    ws.send(JSON.stringify({ success: false, type: data.type, cause: "Only alphabetical characters, numbers, spaces and the characters '.-_@' are allowed in a username (minimum 3 characters, maximum 20 characters)!" }));

                    ws.close();
                    return;
                }

                // Get the stream's token
                const streamToken = global.streams.get(data.stream).token;

                // Subscribe the client so that he can get information
                // and add him to the websocketClients object

                ws.subscribe(data.stream);
                websocketClients.set(ws, {
                    username: data.username,
                    ip: ws.data.ip,
                    country: (await (await fetch(`https://ipapi.co/${ws.data.ip}/json/`)).json())?.country_code,
                    stream: data.stream,
                    host: streamToken == data.token
                });

                ws.send(JSON.stringify({ success: true, type: data.type, message: `Now watching stream ${data.stream}!` }));
                return;
            }

            // If the client is in the object, just get them here
            const client = websocketClients.get(ws);

            // Check if the stream has ended
            if (!global.streams.has(client.stream)) {
                ws.send(JSON.stringify({ success: false, type: data.type, cause: `Stream ${data.stream} ended!` }));

                ws.close();
                return;
            }

            const stream = global.streams.get(client.stream);

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
                case "message": // Send messages
                    if (!data.message)
                        return ws.send(JSON.stringify({ success: false, type: data.type, cause: "No message!" }));

                    stream.keepAlive = Date.now();
                    global.streams.set(client.stream, stream);

                    server.publish(client.stream, JSON.stringify({
                        success: true,
                        type: data.type,
                        username: client.username,
                        host: client.host,
                        country: client.country,
                        message: data.message
                    }));
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
}, 10_000); // Every 10 seconds

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