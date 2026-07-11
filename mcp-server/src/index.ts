import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import * as fs from "fs";
import * as path from "path";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Point these to where the SMAPI mod is installed (its Mods/StardewMCPBridge/ folder)
const BRIDGE_PATH = process.env.STARDEW_BRIDGE_PATH
    || path.resolve(__dirname, "../../smapi-mod/bridge_data.json");
const ACTION_DIR = process.env.STARDEW_ACTION_DIR
    || path.resolve(__dirname, "../../smapi-mod/actions");
const PORT = parseInt(process.env.STARDEW_MCP_PORT || "7845", 10);
// Public URL prefix when served behind a strip-prefix reverse proxy,
// e.g. "/stardew/secret". Advertised in the SSE endpoint event so clients
// on the far side of the proxy POST back through the same prefix.
const PUBLIC_PREFIX = process.env.STARDEW_MCP_PREFIX || "";

// Monotonic counter so two commands issued within the same millisecond still
// get distinct, lexically-ordered filenames (single-threaded server, no locking needed).
let actionSeq = 0;

function sendAction(action: object): string {
    // One immutable file per command. The mod drains them in filename order and
    // deletes each after processing — a race-free queue that can't drop or
    // double-execute commands the way a single overwritten file could.
    fs.mkdirSync(ACTION_DIR, { recursive: true });
    const name = `${Date.now()}-${String(actionSeq++).padStart(6, "0")}`;
    const finalPath = path.join(ACTION_DIR, `${name}.json`);
    const tmpPath = `${finalPath}.tmp`;
    // Atomic publish: write to temp then rename so the mod never reads a partial file.
    fs.writeFileSync(tmpPath, JSON.stringify(action));
    fs.renameSync(tmpPath, finalPath);
    return "Command sent.";
}

function readBridge(): string {
    if (fs.existsSync(BRIDGE_PATH)) {
        return fs.readFileSync(BRIDGE_PATH, "utf-8");
    }
    return '{"error": "Bridge file not found. Is the SMAPI mod running?"}';
}

// Helper to read companion state from bridge data
function getCompanionState(companionName: string): string {
    const raw = readBridge();
    try {
        const data = JSON.parse(raw);
        if (data.companions) {
            const companion = (data.companions as any[]).find((c: any) => c.name === companionName);
            if (companion) return JSON.stringify(companion, null, 2);
        }
        return `Companion "${companionName}" not found in bridge data.`;
    } catch {
        return raw;
    }
}

function getCompanionSurroundings(companionName: string): string {
    const raw = readBridge();
    try {
        const data = JSON.parse(raw);
        if (data.companions) {
            const companion = (data.companions as any[]).find((c: any) => c.name === companionName);
            if (companion?.surroundings) return JSON.stringify({
                tile: companion.tile,
                location: companion.location,
                surroundings: companion.surroundings,
            }, null, 2);
            if (companion) return `Companion "${companionName}" has no surroundings data (is it in player mode?).`;
        }
        return `Companion "${companionName}" not found in bridge data.`;
    } catch {
        return raw;
    }
}

function getCompanionInventory(companionName: string): string {
    const raw = readBridge();
    try {
        const data = JSON.parse(raw);
        if (data.companions) {
            const companion = (data.companions as any[]).find((c: any) => c.name === companionName);
            if (companion?.inventory) return JSON.stringify(companion.inventory, null, 2);
            if (companion) return `Companion "${companionName}" has no inventory data (is it in player mode?).`;
        }
        return `Companion "${companionName}" not found in bridge data.`;
    } catch {
        return raw;
    }
}

const COMPANION_ENUM = ["Erik"];
const MODE_ENUM = ["follow", "farm", "mine", "fish", "idle", "player"];
const TOOL_ENUM = ["pickaxe", "axe", "hoe", "watering_can", "sword"];
const DIRECTION_DESC = "0=up, 1=right, 2=down, 3=left";

function createServer(): Server {
    const server = new Server(
        { name: "stardew-mcp-bridge", version: "0.3.0" },
        { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                // ============================
                // GLOBAL TOOLS (existing)
                // ============================
                {
                    name: "stardew_get_state",
                    description: "Get current game state — time, weather, location, player stats, companion status, nearby NPCs.",
                    inputSchema: { type: "object", properties: {} },
                },
                {
                    name: "stardew_spawn",
                    description: "Spawn companions into the game world near the player.",
                    inputSchema: { type: "object", properties: {} },
                },
                {
                    name: "stardew_follow",
                    description: "Make all companions follow the player.",
                    inputSchema: { type: "object", properties: {} },
                },
                {
                    name: "stardew_stay",
                    description: "Make all companions stop and stay at their current position.",
                    inputSchema: { type: "object", properties: {} },
                },
                {
                    name: "stardew_farm",
                    description: "Enable auto-farm mode for all companions.",
                    inputSchema: { type: "object", properties: {} },
                },
                {
                    name: "stardew_mine",
                    description: "Enable combat/mining mode for all companions.",
                    inputSchema: { type: "object", properties: {} },
                },
                {
                    name: "stardew_fish",
                    description: "Enable fishing mode for all companions.",
                    inputSchema: { type: "object", properties: {} },
                },
                {
                    name: "stardew_water_all",
                    description: "Instantly water all unwatered crops in the current location.",
                    inputSchema: { type: "object", properties: {} },
                },
                {
                    name: "stardew_harvest_all",
                    description: "Instantly harvest all ready crops in the current location.",
                    inputSchema: { type: "object", properties: {} },
                },
                {
                    name: "stardew_chat",
                    description: "Send a chat message in the game.",
                    inputSchema: {
                        type: "object",
                        properties: { message: { type: "string" } },
                        required: ["message"],
                    },
                },
                {
                    name: "stardew_warp",
                    description: "Warp all companions to a location.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            location: { type: "string", description: "Location name (Farm, Town, Mine, Beach, Forest, Mountain, etc.)." },
                            x: { type: "number", description: "Tile X." },
                            y: { type: "number", description: "Tile Y." },
                        },
                        required: ["location", "x", "y"],
                    },
                },
                {
                    name: "stardew_set_mode",
                    description: "Set a specific companion's mode. Modes: follow, farm, mine, fish, idle, player.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            target: { type: "string", enum: COMPANION_ENUM },
                            mode: { type: "string", enum: MODE_ENUM },
                        },
                        required: ["target", "mode"],
                    },
                },
                {
                    name: "stardew_action",
                    description: "Send a custom action (water, harvest, clear, hoe) at a tile.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            actionType: { type: "string" },
                            x: { type: "number" },
                            y: { type: "number" },
                        },
                        required: ["actionType"],
                    },
                },

                // ============================
                // PLAYER MODE — Direct Control
                // ============================
                {
                    name: "stardew_get_surroundings",
                    description: "Get what a companion can see — tiles, objects, crops, monsters, NPCs in a radius around them. The companion's 'eyes'. Companion must be in player mode.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            companion: { type: "string", enum: COMPANION_ENUM, description: "Which companion." },
                        },
                        required: ["companion"],
                    },
                },
                {
                    name: "stardew_get_inventory",
                    description: "Get a companion's inventory — tools and items they're carrying.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            companion: { type: "string", enum: COMPANION_ENUM },
                        },
                        required: ["companion"],
                    },
                },
                {
                    name: "stardew_get_companion_state",
                    description: "Get detailed state for a specific companion — position, location, health, stamina, mode, surroundings (if in player mode), inventory, last command result.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            companion: { type: "string", enum: COMPANION_ENUM },
                        },
                        required: ["companion"],
                    },
                },
                {
                    name: "stardew_move_to",
                    description: "Move a companion to a tile via pathfinding. Async — check surroundings on next tick to see progress.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            companion: { type: "string", enum: COMPANION_ENUM },
                            x: { type: "number", description: "Target tile X." },
                            y: { type: "number", description: "Target tile Y." },
                        },
                        required: ["companion", "x", "y"],
                    },
                },
                {
                    name: "stardew_warp_companion",
                    description: "Teleport a specific companion to a named location.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            companion: { type: "string", enum: COMPANION_ENUM },
                            location: { type: "string", description: "Location name." },
                            x: { type: "number", description: "Tile X." },
                            y: { type: "number", description: "Tile Y." },
                        },
                        required: ["companion", "location", "x", "y"],
                    },
                },
                {
                    name: "stardew_face_direction",
                    description: `Turn a companion to face a direction. ${DIRECTION_DESC}.`,
                    inputSchema: {
                        type: "object",
                        properties: {
                            companion: { type: "string", enum: COMPANION_ENUM },
                            direction: { type: "number", description: DIRECTION_DESC },
                        },
                        required: ["companion", "direction"],
                    },
                },
                {
                    name: "stardew_use_tool",
                    description: "Use a tool at a tile. Tools: pickaxe, axe, hoe, watering_can, sword.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            companion: { type: "string", enum: COMPANION_ENUM },
                            tool: { type: "string", enum: TOOL_ENUM },
                            x: { type: "number", description: "Target tile X." },
                            y: { type: "number", description: "Target tile Y." },
                        },
                        required: ["companion", "tool", "x", "y"],
                    },
                },
                {
                    name: "stardew_interact",
                    description: "Interact with an object, crop, chest, ladder, or machine at a tile.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            companion: { type: "string", enum: COMPANION_ENUM },
                            x: { type: "number", description: "Target tile X." },
                            y: { type: "number", description: "Target tile Y." },
                        },
                        required: ["companion", "x", "y"],
                    },
                },
                {
                    name: "stardew_attack",
                    description: "Attack the nearest monster with equipped weapon.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            companion: { type: "string", enum: COMPANION_ENUM },
                        },
                        required: ["companion"],
                    },
                },
                {
                    name: "stardew_cast_fishing_rod",
                    description: "Cast the fishing rod and auto-hook when a fish bites. Companion must be near water.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            companion: { type: "string", enum: COMPANION_ENUM },
                        },
                        required: ["companion"],
                    },
                },
                {
                    name: "stardew_set_auto_combat",
                    description: "Toggle auto-combat: when enabled, the companion automatically attacks nearby monsters each tick.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            companion: { type: "string", enum: COMPANION_ENUM },
                            enabled: { type: "boolean", description: "true to enable, false to disable." },
                        },
                        required: ["companion", "enabled"],
                    },
                },
                {
                    name: "stardew_speak",
                    description: "Make a companion speak in-game: opens a dialogue box with their portrait and name. Use # in text to split pages. Optional emote bubble (20=heart, 8=question, 32=exclamation, 16=music note). Set queue=true to stage the line so it plays when the player next clicks the companion instead of interrupting them.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            companion: { type: "string", enum: COMPANION_ENUM },
                            text: { type: "string", description: "What to say. Use # to split into multiple dialogue pages." },
                            emote: { type: "number", description: "Optional emote bubble id shown above the companion's head." },
                            queue: { type: "boolean", description: "If true, stage the dialogue for the player's next click instead of showing it immediately." },
                        },
                        required: ["companion", "text"],
                    },
                },
                {
                    name: "stardew_get_events",
                    description: "Get recent player→companion interaction events. When the player clicks a companion to talk, or gives them a gift/bouquet, an event lands here (with item, gift taste, friendship points/hearts). Poll this while playing together and respond with stardew_speak. Events have monotonic ids — track the last id you've handled.",
                    inputSchema: { type: "object", properties: {} },
                },
                {
                    name: "stardew_eat_item",
                    description: "Eat a food item from inventory to restore health/stamina.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            companion: { type: "string", enum: COMPANION_ENUM },
                            slot: { type: "number", description: "Inventory slot index (optional — picks first edible if omitted)." },
                        },
                        required: ["companion"],
                    },
                },
            ],
        }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            const a = (args || {}) as any;

            try {
                // --- Global tools ---
                switch (name) {
                    case "stardew_get_state":
                        return ok(readBridge());

                    case "stardew_spawn":
                        return ok(sendAction({ actionType: "spawn" }));

                    case "stardew_follow":
                        return ok(sendAction({ actionType: "follow" }));

                    case "stardew_stay":
                        return ok(sendAction({ actionType: "stay" }));

                    case "stardew_farm":
                        return ok(sendAction({ actionType: "farm" }));

                    case "stardew_water_all":
                        return ok(sendAction({ actionType: "water_all" }));

                    case "stardew_harvest_all":
                        return ok(sendAction({ actionType: "harvest_all" }));

                    case "stardew_mine":
                        return ok(sendAction({ actionType: "mine" }));

                    case "stardew_fish":
                        return ok(sendAction({ actionType: "fish" }));

                    case "stardew_warp":
                        if (!a.location || a.x == null || a.y == null)
                            return err("location, x, and y are required.");
                        return ok(sendAction({ actionType: "warp", location: a.location, x: a.x, y: a.y }));

                    case "stardew_set_mode":
                        if (!a.target || !a.mode)
                            return err("target and mode are required.");
                        return ok(sendAction({ actionType: "set_mode", target: a.target, mode: a.mode }));

                    case "stardew_chat":
                        if (!a.message)
                            return err("message is required.");
                        return ok(sendAction({ actionType: "chat", metadata: { message: a.message } }));

                    case "stardew_action":
                        if (!a.actionType)
                            return err("actionType is required.");
                        // Forward only the known fields rather than the raw args object,
                        // so arbitrary client-supplied keys can't leak into the bridge.
                        return ok(sendAction({
                            actionType: a.actionType,
                            ...(a.x != null ? { x: a.x } : {}),
                            ...(a.y != null ? { y: a.y } : {}),
                        }));

                    // --- Player mode: companion-targeted commands ---
                    case "stardew_get_surroundings":
                        if (!a.companion) return err("companion is required.");
                        // Extract just surroundings from bridge data (companion must be in player mode)
                        return ok(getCompanionSurroundings(a.companion));

                    case "stardew_get_inventory":
                        if (!a.companion) return err("companion is required.");
                        return ok(getCompanionInventory(a.companion));

                    case "stardew_get_companion_state":
                        if (!a.companion) return err("companion is required.");
                        return ok(getCompanionState(a.companion));

                    case "stardew_move_to":
                        if (!a.companion || a.x == null || a.y == null)
                            return err("companion, x, and y are required.");
                        return ok(sendAction({
                            actionType: "move_to",
                            companion: a.companion,
                            x: a.x, y: a.y,
                        }));

                    case "stardew_warp_companion":
                        if (!a.companion || !a.location || a.x == null || a.y == null)
                            return err("companion, location, x, and y are required.");
                        return ok(sendAction({
                            actionType: "warp_to",
                            companion: a.companion,
                            location: a.location,
                            x: a.x, y: a.y,
                        }));

                    case "stardew_face_direction":
                        if (!a.companion || a.direction == null)
                            return err("companion and direction are required.");
                        return ok(sendAction({
                            actionType: "face_direction",
                            companion: a.companion,
                            direction: a.direction,
                        }));

                    case "stardew_use_tool":
                        if (!a.companion || !a.tool || a.x == null || a.y == null)
                            return err("companion, tool, x, and y are required.");
                        return ok(sendAction({
                            actionType: "use_tool",
                            companion: a.companion,
                            tool: a.tool,
                            x: a.x, y: a.y,
                        }));

                    case "stardew_interact":
                        if (!a.companion || a.x == null || a.y == null)
                            return err("companion, x, and y are required.");
                        return ok(sendAction({
                            actionType: "interact",
                            companion: a.companion,
                            x: a.x, y: a.y,
                        }));

                    case "stardew_attack":
                        if (!a.companion) return err("companion is required.");
                        return ok(sendAction({
                            actionType: "attack",
                            companion: a.companion,
                        }));

                    case "stardew_cast_fishing_rod":
                        if (!a.companion) return err("companion is required.");
                        return ok(sendAction({
                            actionType: "cast_fishing_rod",
                            companion: a.companion,
                        }));

                    case "stardew_set_auto_combat":
                        if (!a.companion || a.enabled == null)
                            return err("companion and enabled are required.");
                        return ok(sendAction({
                            actionType: "set_auto_combat",
                            companion: a.companion,
                            enabled: a.enabled,
                        }));

                    case "stardew_speak":
                        if (!a.companion || !a.text)
                            return err("companion and text are required.");
                        return ok(sendAction({
                            actionType: "speak",
                            companion: a.companion,
                            text: a.text,
                            ...(a.emote != null ? { emote: a.emote } : {}),
                            ...(a.queue != null ? { queue: a.queue } : {}),
                        }));

                    case "stardew_get_events": {
                        const raw = readBridge();
                        try {
                            const data = JSON.parse(raw);
                            return ok(JSON.stringify(data.events ?? [], null, 2));
                        } catch {
                            return ok(raw);
                        }
                    }

                    case "stardew_eat_item":
                        if (!a.companion) return err("companion is required.");
                        return ok(sendAction({
                            actionType: "eat_item",
                            companion: a.companion,
                            ...(a.slot != null ? { slot: a.slot } : {}),
                        }));

                    default:
                        return err(`Unknown tool: ${name}`);
                }
            } catch (error: any) {
                return err(error.message);
            }
        });

    return server;
}

function ok(text: string) {
    return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
    return { content: [{ type: "text" as const, text: `Error: ${text}` }] };
}

const useSSE = process.argv.includes("--sse");

// ── Event push to gateway ──
// When set (e.g. https://chat.erikssheep.uk/api/stardew/event), watch the
// bridge file for new player→companion events and POST them to the gateway,
// which debounces and injects them into Erik's bound chat session.
const EVENT_WEBHOOK = process.env.STARDEW_EVENT_WEBHOOK || "";

function startEventPusher() {
    // Start from the current max id so a server restart never replays history.
    let lastPushedId = 0;
    try {
        const data = JSON.parse(fs.readFileSync(BRIDGE_PATH, "utf-8"));
        const evs: any[] = data.events ?? [];
        lastPushedId = evs.reduce((m, e) => Math.max(m, e.id ?? 0), 0);
    } catch {
        // bridge file missing or mid-write — 0 is fine, mod ids restart per session
    }
    let failStreak = 0;
    setInterval(async () => {
        let newEvents: any[];
        try {
            const data = JSON.parse(fs.readFileSync(BRIDGE_PATH, "utf-8"));
            newEvents = (data.events ?? []).filter((e: any) => (e.id ?? 0) > lastPushedId);
        } catch {
            return; // file missing or being written by the mod — try next tick
        }
        if (!newEvents.length) return;
        try {
            const res = await (globalThis as any).fetch(EVENT_WEBHOOK, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ events: newEvents }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            lastPushedId = newEvents.reduce((m, e) => Math.max(m, e.id ?? 0), lastPushedId);
            failStreak = 0;
            console.log(`[events] pushed ${newEvents.length} event(s), lastId=${lastPushedId}`);
        } catch (e: any) {
            failStreak++;
            // keep lastPushedId unchanged so the batch retries next tick
            if (failStreak <= 3 || failStreak % 30 === 0) {
                console.warn(`[events] webhook push failed x${failStreak}: ${e?.message ?? e}`);
            }
        }
    }, 2000);
    console.log(`[events] pusher active → ${EVENT_WEBHOOK}`);
}

if (useSSE) {
    const app = express();
    app.use(express.json());

    const transports = new Map<string, SSEServerTransport>();

    app.get("/sse", async (_req, res) => {
        const server = createServer();
        const transport = new SSEServerTransport(`${PUBLIC_PREFIX}/message`, res);
        transports.set(transport.sessionId, transport);
        res.on("close", () => {
            transports.delete(transport.sessionId);
            server.close().catch(() => {});
        });
        await server.connect(transport);
    });

    const handleMessage: express.RequestHandler = async (req, res) => {
        const sessionId = req.query.sessionId as string;
        const transport = transports.get(sessionId);
        if (transport) {
            // express.json() already consumed the request stream — pass the
            // parsed body explicitly or the SDK hangs trying to re-read it.
            await transport.handlePostMessage(req, res, req.body);
        } else {
            res.status(400).json({ error: "Unknown session" });
        }
    };
    app.post("/message", handleMessage);
    // Also mount the prefixed path so direct (non-proxied) clients that
    // follow the advertised endpoint still land on a valid route.
    if (PUBLIC_PREFIX) app.post(`${PUBLIC_PREFIX}/message`, handleMessage);

    app.get("/health", (_req, res) => {
        res.json({
            ok: true,
            bridge: fs.existsSync(BRIDGE_PATH),
            sessions: transports.size,
            bridgePath: BRIDGE_PATH,
            actionDir: ACTION_DIR,
        });
    });

    app.listen(PORT, () => {
        console.log(`Stardew MCP Bridge v0.3.0 (SSE) on http://localhost:${PORT}`);
        console.log(`  SSE: http://localhost:${PORT}/sse`);
        console.log(`  Bridge: ${BRIDGE_PATH}`);
    });

    if (EVENT_WEBHOOK) startEventPusher();
} else {
    const server = createServer();
    const transport = new StdioServerTransport();
    server.connect(transport).then(() => {
        console.error(`Stardew MCP Bridge v0.3.0 (stdio) — bridge: ${BRIDGE_PATH}`);
    });
}
