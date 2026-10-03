import apotheonNet from "./multiplayer.js";

const loading   = document.getElementById("loading");
const status    = document.getElementById("status");
const progFill  = document.getElementById("progress-fill");
const canvas    = document.getElementById("canvas");

function setStatus(msg) { status.textContent = msg; }
function setProgress(pct) { progFill.style.width = `${Math.min(100, pct)}%`; }

async function importDotnetRuntime() {
	const candidates = [
		new URL("/_framework/dotnet.js", window.location.origin).href,
		new URL("./_framework/dotnet.js", import.meta.url).href
	];

	let lastError = null;
	for (const url of candidates) {
		try {
			const cacheBust = `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;
			const mod = await import(cacheBust);
			console.log(`[Apotheon] Loaded runtime from ${url}`);
			return mod;
		} catch (e) {
			lastError = e;
			console.warn(`[Apotheon] Runtime import failed at ${url}:`, e);
		}
	}

	throw lastError || new Error("Failed to import dotnet.js from all known locations");
}

async function getTar(baseName, label) {
	const root = await navigator.storage.getDirectory();
	const legacyCacheKey = baseName + ".cache";
	const metaKey = baseName + ".meta.json";
	const chunkDirKey = baseName + ".chunks";

	const countRes = await fetch(baseName + ".count", { cache: "no-store" });
	if (!countRes.ok) throw new Error(`Failed to fetch ${baseName}.count: ${countRes.status}`);
	const chunkCount = parseInt((await countRes.text()).trim(), 10);
	if (!Number.isFinite(chunkCount) || chunkCount <= 0) {
		throw new Error(`Invalid chunk count for ${baseName}: ${chunkCount}`);
	}

	let chunkDir = null;
	try {
		chunkDir = await root.getDirectoryHandle(chunkDirKey, { create: true });
	} catch {}

	let meta = null;
	try {
		const metaHandle = await root.getFileHandle(metaKey, { create: false });
		const metaFile = await metaHandle.getFile();
		meta = JSON.parse(await metaFile.text());
	} catch {}

	const canUseChunkCache = !!chunkDir && !!meta && meta.chunkCount === chunkCount;

	if (!canUseChunkCache) {
		try {
			const fh = await root.getFileHandle(legacyCacheKey, { create: false });
			const file = await fh.getFile();
			setStatus(`Reading cached ${label}...`);
			return new Uint8Array(await file.arrayBuffer());
		} catch {}
	}

	const chunks = [];
	let received = 0;
	let downloadedAny = false;

	for (let i = 0; i < chunkCount; i++) {
		const chunkName = `chunk${String(i).padStart(4, "0")}`;
		let chunkData = null;

		if (canUseChunkCache) {
			try {
				const ch = await chunkDir.getFileHandle(chunkName, { create: false });
				const file = await ch.getFile();
				chunkData = new Uint8Array(await file.arrayBuffer());
			} catch {}
		}

		if (!chunkData) {
			downloadedAny = true;
			const url = `${baseName}${String(i).padStart(2, "0")}`;
			const res = await fetch(url);
			if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
			chunkData = new Uint8Array(await res.arrayBuffer());

			if (chunkDir) {
				try {
					const ch = await chunkDir.getFileHandle(chunkName, { create: true });
					const writable = await ch.createWritable();
					await writable.write(chunkData);
					await writable.close();
				} catch (e) {
					console.warn(`[Apotheon] Failed to cache ${chunkName}:`, e);
				}
			}
		}

		chunks.push(chunkData);
		received += chunkData.length;

		if (downloadedAny) {
			setStatus(`Downloading ${label}... ${(received / 1048576) | 0} MB`);
		} else {
			setStatus(`Reading cached ${label}... ${(received / 1048576) | 0} MB`);
		}
		setProgress(10 + ((i + 1) / chunkCount) * 40);
	}

	const tar = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		tar.set(chunk, offset);
		offset += chunk.length;
	}

	if (chunkDir) {
		try {
			const metaHandle = await root.getFileHandle(metaKey, { create: true });
			const writable = await metaHandle.createWritable();
			await writable.write(JSON.stringify({
				chunkCount,
				totalBytes: received,
				updatedAt: Date.now()
			}));
			await writable.close();
		} catch (e) {
			console.warn("Failed to write chunk cache metadata:", e);
		}
	}

	if (downloadedAny) {
		setStatus(`Cached ${label}`);
	}

	return tar;
}

const YIELD_BYTES = 2 * 1024 * 1024;

async function extractTar(tar, prefix, FS, progressCb) {
	let pos = 0;
	let fileCount = 0;
	let bytesSinceYield = 0;
	const decoder = new TextDecoder();
	const knownDirs = new Set();

	function readString(buf, off, len) {
		let end = off;
		while (end < off + len && buf[end] !== 0) end++;
		return decoder.decode(buf.subarray(off, end));
	}

	function readOctal(buf, off, len) {
		const s = readString(buf, off, len).trim();
		return s ? parseInt(s, 8) : 0;
	}

	function mkdirp(path) {
		if (knownDirs.has(path)) return;
		const parts = path.split("/").filter(Boolean);
		let cur = "";
		for (const p of parts) {
			cur += "/" + p;
			if (!knownDirs.has(cur)) {
				try { FS.mkdir(cur); } catch {}
				knownDirs.add(cur);
			}
		}
	}

	while (pos + 512 <= tar.length) {
		const header = tar.subarray(pos, pos + 512);
		const v = new DataView(header.buffer, header.byteOffset, 8);
		if (v.getFloat64(0) === 0) {
			let allZero = true;
			for (let i = 8; i < 512; i += 8) {
				const v2 = new DataView(header.buffer, header.byteOffset + i, 8);
				if (v2.getFloat64(0) !== 0) { allZero = false; break; }
			}
			if (allZero) break;
		}

		const name = readString(header, 0, 100);
		const size = readOctal(header, 124, 12);
		const typeFlag = header[156];
		const pref = readString(header, 345, 155);
		const fullName = pref ? pref + "/" + name : name;
		const fullPath = prefix + fullName;

		pos += 512;

		if (typeFlag === 53 || typeFlag === 0x35 || name.endsWith("/")) {
			mkdirp(fullPath.replace(/\/+$/, ""));
		} else if (typeFlag === 48 || typeFlag === 0 || typeFlag === 0x30) {
			const lastSlash = fullPath.lastIndexOf("/");
			if (lastSlash > 0) mkdirp(fullPath.substring(0, lastSlash));
			FS.writeFile(fullPath, tar.subarray(pos, pos + size));
			fileCount++;
			bytesSinceYield += size;
			if (bytesSinceYield >= YIELD_BYTES) {
				bytesSinceYield = 0;
				if (progressCb) progressCb(fileCount, pos, tar.length);
				await new Promise(r => setTimeout(r, 0));
			}
		}

		pos += Math.ceil(size / 512) * 512;
	}
	if (progressCb) progressCb(fileCount, tar.length, tar.length);
	return fileCount;
}
try {

setStatus("Loading...");
setProgress(5);
const contentTarP = getTar("Content.tar", "game content");
const dialogTarP  = getTar("Dialog.tar", "dialog data");
const dotnetP     = importDotnetRuntime();

let contentTar = await contentTarP;
setProgress(45);

let dialogTar = await dialogTarP;
setProgress(55);

setStatus("Loading .NET runtime...");
const { dotnet } = await dotnetP;
setProgress(60);

const runtime = await dotnet
	.withModuleConfig({ canvas })
	.withConfig({ pthreadPoolInitialSize: 16 })
	.withEnvironmentVariable("MONO_SLEEP_ABORT_LIMIT", "99999")
	.create();

const config = runtime.getConfig();
const exports = await runtime.getAssemblyExports(config.mainAssemblyName);

const Module = runtime.Module;
self.wasm = { Module, dotnet, runtime, config, exports };

if (!exports?.WasmLoader) {
	throw new Error("WasmLoader not found. Keys: " +
		(exports ? JSON.stringify(Object.keys(exports)) : "null"));
}

const FS = Module.FS;

setStatus("Mounting filesystem...");
setProgress(65);

await exports.WasmLoader.PreInit();
try { FS.unlink("/Content"); } catch {}
try { FS.unlink("/Dialog"); } catch {}
try { FS.mkdir("/Content"); } catch {}
try { FS.mkdir("/Dialog"); } catch {}
console.log("[Apotheon] Switched Content/Dialog to in-memory FS");

setStatus("Extracting game content...");
setProgress(68);

let total = await extractTar(contentTar, "/", FS, (files, pos, len) => {
	const pct = 68 + (pos / len) * 17;
	setProgress(pct);
	setStatus(`Extracting game content... ${files} files`);
});
contentTar = null; // free memory
console.log(`[Apotheon] Extracted ${total} content files`);

setStatus("Extracting dialog data...");
setProgress(85);

const dialogCount = await extractTar(dialogTar, "/", FS, (files, pos, len) => {
	const pct = 85 + (pos / len) * 5;
	setProgress(pct);
	setStatus(`Extracting dialog data... ${files} files`);
});
dialogTar = null;
total += dialogCount;
console.log(`[Apotheon] Extracted ${dialogCount} dialog files (${total} total)`);


function fitCanvas() {
	const gameW = canvas.width;
	const gameH = canvas.height;
	const winW = window.innerWidth;
	const winH = window.innerHeight;
	const scale = Math.min(winW / gameW, winH / gameH);
	canvas.style.width  = Math.floor(gameW * scale) + "px";
	canvas.style.height = Math.floor(gameH * scale) + "px";
}

function syncCanvasBackbufferSize() {
	const glctx = self.wasm?.Module?.GL?.currentContext?.GLctx;
	const drawW = glctx?.drawingBufferWidth || canvas.width;
	const drawH = glctx?.drawingBufferHeight || canvas.height;

	if (drawW > 0 && drawH > 0 && (canvas.width !== drawW || canvas.height !== drawH)) {
		canvas.width = drawW;
		canvas.height = drawH;
		fitCanvas();
	}
}


function requestGamePointerLock() {
	if (!canvas.classList.contains("visible")) return;
	if (document.pointerLockElement === canvas) return;
	if (!document.hasFocus()) return;
	const lockResult = canvas.requestPointerLock?.();
	if (lockResult?.catch) lockResult.catch(() => {});
}

function installInputHooks() {
	canvas.setAttribute("tabindex", "0");

	window.addEventListener("keydown", (e) => {
		if (["Tab", "Escape", "F1", "F5", "F11"].includes(e.key)) {
			e.preventDefault();
		}
		if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
			e.preventDefault();
		}
	});

	const focusAndLock = () => {
		canvas.focus();
		requestGamePointerLock();
	};
	canvas.addEventListener("click", focusAndLock);
	canvas.addEventListener("mousedown", focusAndLock);

	document.addEventListener("pointerlockchange", () => {
		if (!canvas.classList.contains("visible")) return;
		if (document.pointerLockElement !== canvas) {
			setStatus("Click the game window to lock mouse");
		}
	});

	try {
		const lockResult = navigator.keyboard?.lock?.();
		if (lockResult?.catch) {
			lockResult.catch(() => {});
		}
	} catch {}
}


setStatus("Starting Apotheon...");
setProgress(90);

await exports.WasmLoader.Init(canvas.width, canvas.height);
setProgress(95);

canvas.classList.add("visible");
document.body.classList.add("game-active");
loading.classList.add("hidden");
if (window.hideGameConsole) window.hideGameConsole();
fitCanvas();
window.addEventListener("resize", fitCanvas);
installInputHooks();
canvas.focus();
setProgress(100);
let frameCount = 0;
let frameErrorCount = 0;
let lastHeartbeat = 0;

const commitGLFrame = () => {
	const gl = self.wasm?.Module?.GL;
	if (gl?.currentContext && !gl.currentContext.attributes?.explicitSwapControl) {
		gl.currentContext.GLctx?.commit?.();
	}
};

const runFrame = async () => {
	try {
		const ret = await exports.WasmLoader.MainLoop();
		syncCanvasBackbufferSize();
		commitGLFrame();
		frameErrorCount = 0;
		frameCount++;

		const now = performance.now();
		if (now - lastHeartbeat >= 5000) {
			const fps = lastHeartbeat > 0 ? Math.round(frameCount / ((now - lastHeartbeat) / 1000)) : 0;
			console.log(`[Apotheon] Heartbeat: frame ${frameCount}, ~${fps} fps`);
			lastHeartbeat = now;
			frameCount = 0;
		}

		if (ret === undefined || ret === null) {
			console.warn("[Apotheon] MainLoop returned undefined, recovering...");
			requestAnimationFrame(runFrame);
		} else if (ret === 1) {
			requestAnimationFrame(runFrame);
		} else {
			console.debug("[Apotheon] Game loop ended");
			await exports.WasmLoader.Cleanup();
		}
	} catch (e) {
		console.error("Frame error:", e);
		frameErrorCount++;
		if (frameErrorCount <= 10) {
			requestAnimationFrame(runFrame);
		} else {
			setStatus("Game loop stopped after repeated errors. Reload the page.");
		}
	}
};

console.debug("[Apotheon] Starting frame loop...");
requestAnimationFrame(runFrame);

try {

	const bridge = exports?.Lidgren?.Network?.WasmNetBridge;
	if (bridge) {
		apotheonNet.setBridge({
			OnPeerConnected: (peerId) => {
				try { bridge.OnPeerConnected(peerId); } catch (e) {
					console.error("[Bridge] OnPeerConnected error:", e);
				}
			},
			OnPeerDisconnected: (peerId) => {
				try { bridge.OnPeerDisconnected(peerId); } catch (e) {
					console.error("[Bridge] OnPeerDisconnected error:", e);
				}
			},
			OnDataReceived: (peerId, base64Data) => {
				try { bridge.OnDataReceived(peerId, base64Data); } catch (e) {
					console.error("[Bridge] OnDataReceived error:", e);
				}
			},
			OnPeerIdAssigned: (peerId) => {
				try { bridge.OnPeerIdAssigned(peerId); } catch (e) {
					console.error("[Bridge] OnPeerIdAssigned error:", e);
				}
			},
		});
		console.log("[Apotheon] Multiplayer bridge wired (PeerJS ↔ Lidgren shim)");
	} else {
		console.warn("[Apotheon] WasmNetBridge not found — multiplayer will not work");
	}
} catch (e) {
	console.warn("[Apotheon] Failed to wire multiplayer bridge:", e);
}

} catch (e) {
	console.error("[Apotheon] Fatal error:", e);
	setStatus(`Error: ${e.message || e}`);
	loading.classList.remove("hidden");
}
