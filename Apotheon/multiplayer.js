const PEERJS_CONFIG = {
	config: {
		iceServers: [
			{ urls: "stun:stun.l.google.com:19302" },
			{ urls: "stun:stun1.l.google.com:19302" },
			{ urls: "stun:stun2.l.google.com:19302" },
		],
	},
	debug: 1,
};

let peer = null;
const connections = new Map();
let localPeerId = null;
let isHost = false;

let bridge = null;

function initPeer(idPrefix) {
	return new Promise((resolve, reject) => {
		if (typeof Peer === "undefined") {
			reject(new Error("PeerJS not loaded"));
			return;
		}

		const cfg = window.APOTHEON_PEER_CONFIG || PEERJS_CONFIG;

		const id = idPrefix
			? `apotheon-${idPrefix}-${Math.random().toString(36).slice(2, 8)}`
			: undefined;

		peer = new Peer(id, cfg);

		peer.on("open", (assignedId) => {
			localPeerId = assignedId;
			console.log(`[PeerJS] Connected as: ${assignedId}`);
			bridge?.OnPeerIdAssigned(assignedId);
			resolve(assignedId);
		});

		peer.on("connection", (conn) => {
			console.log(`[PeerJS] Incoming connection from: ${conn.peer}`);
			setupConnection(conn);
		});

		peer.on("error", (err) => {
			console.error("[PeerJS] Error:", err);
			if (!localPeerId) reject(err);
		});

		peer.on("disconnected", () => {
			console.warn("[PeerJS] Disconnected from signaling, reconnecting...");
			try { peer.reconnect(); } catch {}
		});
	});
}

function setupConnection(conn) {
	const remotePeerId = conn.peer;

	conn.on("open", () => {
		console.log(`[PeerJS] DataChannel open with: ${remotePeerId}`);
		connections.set(remotePeerId, conn);
		bridge?.OnPeerConnected(remotePeerId);
	});

	conn.on("data", (data) => {
		let base64;
		if (data instanceof ArrayBuffer) {
			base64 = arrayBufferToBase64(new Uint8Array(data));
		} else if (data instanceof Uint8Array) {
			base64 = arrayBufferToBase64(data);
		} else if (typeof data === "string") {
			base64 = data;
		} else if (data?.type === "binary" && data.data) {
			base64 = arrayBufferToBase64(new Uint8Array(data.data));
		} else {
			console.warn("[PeerJS] Unknown data format:", typeof data);
			return;
		}
		bridge?.OnDataReceived(remotePeerId, base64);
	});

	conn.on("close", () => {
		console.log(`[PeerJS] Connection closed: ${remotePeerId}`);
		connections.delete(remotePeerId);
		bridge?.OnPeerDisconnected(remotePeerId);
	});

	conn.on("error", (err) => {
		console.error(`[PeerJS] Connection error with ${remotePeerId}:`, err);
	});
}

function arrayBufferToBase64(bytes) {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function base64ToArrayBuffer(base64) {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

window.apotheonNet = {
	setBridge(wasmBridge) {
		bridge = wasmBridge;
		console.log("[PeerJS] WASM bridge connected");
	},

	startHost(port) {
		isHost = true;
		if (peer && localPeerId) return localPeerId;
		console.log("[PeerJS] startHost called, deferring init...");
		setTimeout(() => {
			initPeer("host").catch(e => console.error("[PeerJS] Host init failed:", e));
		}, 0);
		return localPeerId || "";
	},

	startClient() {
		isHost = false;
		if (peer && localPeerId) return localPeerId;
		console.log("[PeerJS] startClient called, deferring init...");
		setTimeout(() => {
			initPeer("client").catch(e => console.error("[PeerJS] Client init failed:", e));
		}, 0);
		return localPeerId || "";
	},

	connectToHost(hostPeerId) {
		if (!peer) {
			console.error("[PeerJS] Cannot connect — peer not initialized");
			return;
		}
		if (connections.has(hostPeerId)) {
			console.log("[PeerJS] Already connected to:", hostPeerId);
			return;
		}
		console.log(`[PeerJS] Connecting to host: ${hostPeerId}`);
		const conn = peer.connect(hostPeerId, {
			reliable: true,
			serialization: "none",
		});
		setupConnection(conn);
	},

	sendToPeer(peerId, data, reliable) {
		const conn = connections.get(peerId);
		if (!conn || !conn.open) return;
		try {
			if (data instanceof Uint8Array) {
				conn.send(data.buffer);
			} else {
				conn.send(data);
			}
		} catch (e) {
			console.error(`[PeerJS] Send failed to ${peerId}:`, e);
		}
	},

	disconnectPeer(peerId, reason) {
		const conn = connections.get(peerId);
		if (conn) {
			try { conn.close(); } catch {}
			connections.delete(peerId);
		}
	},

	shutdown() {
		for (const [, conn] of connections) {
			try { conn.close(); } catch {}
		}
		connections.clear();
		if (peer) {
			try { peer.destroy(); } catch {}
			peer = null;
		}
		localPeerId = null;
		isHost = false;
		console.log("[PeerJS] Shutdown complete");
	},

	getPeerId() {
		return localPeerId || "";
	},

	getStatus() {
		return {
			peerId: localPeerId,
			isHost,
			connected: peer && !peer.disconnected,
			peerCount: connections.size,
			peers: [...connections.keys()],
		};
	},

	isReady() {
		return !!peer && !!localPeerId && !peer.disconnected;
	},
};

export default window.apotheonNet;
