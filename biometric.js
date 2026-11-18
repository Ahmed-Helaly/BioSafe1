/* ============================================================
   bioSafe — AS608 Cloud Template Sync (Web Serial + WebAuthn)
   ============================================================ */

let serialPort = null;
let portReader = null;
let portWriter = null;
let isScanning = false;

// الحزم القياسية لبروتوكول مستشعر البصمة AS608
const AS608_CMD = {
    VERIFY_PWD:    new Uint8Array([0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x07, 0x13, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1B]),
    GET_IMAGE:     new Uint8Array([0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x03, 0x01, 0x00, 0x05]),
    IMAGE_TO_TZ_1: new Uint8Array([0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x04, 0x02, 0x01, 0x00, 0x08]),
    IMAGE_TO_TZ_2: new Uint8Array([0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x04, 0x02, 0x02, 0x00, 0x09]),
    REG_MODEL:     new Uint8Array([0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x03, 0x05, 0x00, 0x09]),
    UP_CHAR_1:     new Uint8Array([0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x04, 0x08, 0x01, 0x00, 0x0E]),
    DOWN_CHAR_2:   new Uint8Array([0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x04, 0x09, 0x02, 0x00, 0x10]),
    MATCH:         new Uint8Array([0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x03, 0x03, 0x00, 0x07])
};

function getSupabase() {
    if (typeof supabaseClient !== 'undefined') return supabaseClient;
    if (typeof supabase !== 'undefined' && supabase.from) return supabase;
    if (window.supabaseClient) return window.supabaseClient;
    throw new Error("Supabase client not loaded. Ensure supabase.js is included.");
}

// تحويل مصفوفة البايتات إلى Base64 والعكس
function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

// ==========================================
// 1. الاتصال بمستشعر AS608 عبر USB-TTL
// ==========================================
async function connectFingerprintSensor(onStatus) {
    if (!("serial" in navigator)) {
        throw new Error("Web Serial not supported on this device.");
    }

    if (serialPort && serialPort.readable && serialPort.writable) {
        return true;
    }

    try {
        if (onStatus) onStatus("Select the USB-TTL COM port from the browser popup...", "info");
        serialPort = await navigator.serial.requestPort();
        const bauds = [57600, 9600, 115200, 19200, 38400];
        let connected = false;

        for (const baud of bauds) {
            if (onStatus) onStatus(`Trying sensor at ${baud} baud...`, "info");
            try {
                await serialPort.open({ baudRate: baud });
            } catch (openErr) {
                if (openErr.name !== 'InvalidStateError') {
                    throw new Error("Could not open COM port. Close any other serial monitor and replug USB.");
                }
            }

            try {
                portWriter = serialPort.writable.getWriter();
                portReader = serialPort.readable.getReader();
                const verifyRes = await sendPacket(AS608_CMD.VERIFY_PWD, 12, 1500);
                if (verifyRes.length >= 10 && verifyRes[0] === 0xEF && verifyRes[1] === 0x01 && verifyRes[9] === 0x00) {
                    connected = true;
                    break;
                }
            } catch (e) {
                console.warn(`No valid response at ${baud} baud:`, e.message || e);
            }

            try { if (portReader) { await portReader.cancel().catch(() => {}); portReader.releaseLock(); } } catch (e) {}
            try { if (portWriter) portWriter.releaseLock(); } catch (e) {}
            portReader = null;
            portWriter = null;
            try { await serialPort.close(); } catch (e) {}
        }

        if (!connected) {
            throw new Error("AS608 did not respond. Check TX/RX wiring and 3.3V power.");
        }

        if (onStatus) onStatus("AS608 sensor connected!", "success");
        return true;
    } catch (err) {
        await disconnectFingerprintSensor();
        throw err;
    }
}

async function disconnectFingerprintSensor() {
    isScanning = false;
    try {
        if (portReader) { await portReader.cancel(); portReader.releaseLock(); portReader = null; }
        if (portWriter) { portWriter.releaseLock(); portWriter = null; }
        if (serialPort) { await serialPort.close(); serialPort = null; }
    } catch (e) {
        console.warn("Port close warning:", e);
    }
}

async function sendPacket(packet, expectedLength = 12, timeoutMs = 4000) {
    if (!portWriter || !portReader) throw new Error("Serial port is not connected.");
    await portWriter.write(packet);

    let buffer = new Uint8Array(0);
    const startTime = Date.now();

    while (buffer.length < expectedLength) {
        if (Date.now() - startTime > timeoutMs) throw new Error("Sensor response timeout.");
        const remaining = Math.max(1, timeoutMs - (Date.now() - startTime));
        const { value, done } = await Promise.race([
            portReader.read(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Sensor response timeout.")), remaining))
        ]);
        if (done) break;
        if (value) {
            const combined = new Uint8Array(buffer.length + value.length);
            combined.set(buffer);
            combined.set(value, buffer.length);
            buffer = combined;
        }
    }
    return buffer;
}

async function waitForFingerScan(maxWaitMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        if (!isScanning) throw new Error("Scan cancelled.");
        const res = await sendPacket(AS608_CMD.GET_IMAGE, 12);
        if (res[9] === 0x00) return true;
        await sleep(250);
    }
    throw new Error("Timeout: No finger detected on sensor.");
}

// ==========================================
// 2. سحب قالب البصمة (512 بايت) من AS608 إلى المتصفح
// ==========================================
async function downloadTemplateFromSensor() {
    await portWriter.write(AS608_CMD.UP_CHAR_1);

    let rawStream = new Uint8Array(0);
    const startTime = Date.now();
    const expectedTotal = 568; // 12 بايت ACK + 4 حزم × 139 بايت

    while (rawStream.length < expectedTotal) {
        if (Date.now() - startTime > 5000) break;
        const { value, done } = await Promise.race([
            portReader.read(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Template read timeout.")), 3000))
        ]);
        if (done) break;
        if (value) {
            const combined = new Uint8Array(rawStream.length + value.length);
            combined.set(rawStream);
            combined.set(value, rawStream.length);
            rawStream = combined;
        }
    }

    if (rawStream.length < 12 || rawStream[9] !== 0x00) {
        throw new Error("Failed to extract template from AS608.");
    }

    const templateBytes = new Uint8Array(512);
    let offset = 12;
    let outIdx = 0;

    while (offset + 9 <= rawStream.length && outIdx < 512) {
        if (rawStream[offset] === 0xEF && rawStream[offset + 1] === 0x01) {
            const pid = rawStream[offset + 6];
            const pkgLen = (rawStream[offset + 7] << 8) | rawStream[offset + 8];
            const dataLen = pkgLen - 2;
            if (pid === 0x02 || pid === 0x08) {
                const slice = rawStream.slice(offset + 9, offset + 9 + dataLen);
                templateBytes.set(slice.slice(0, 512 - outIdx), outIdx);
                outIdx += slice.length;
            }
            offset += 9 + pkgLen;
            if (pid === 0x08) break;
        } else {
            offset++;
        }
    }

    if (outIdx < 512) {
        throw new Error(`Incomplete fingerprint template (${outIdx}/512 bytes).`);
    }

    return bytesToBase64(templateBytes);
}

// ==========================================
// 3. رفع قالب البصمة من Supabase إلى CharBuffer2 في AS608 للمطابقة
// ==========================================
async function uploadTemplateToSensor(base64Template) {
    const templateBytes = base64ToBytes(base64Template);
    if (templateBytes.length !== 512) return false;

    const ack = await sendPacket(AS608_CMD.DOWN_CHAR_2, 12, 2000);
    if (ack[9] !== 0x00) return false;

    const chunkSize = 128;
    for (let i = 0; i < 4; i++) {
        const isLast = (i === 3);
        const pid = isLast ? 0x08 : 0x02;
        const pkgLen = chunkSize + 2;
        const chunk = templateBytes.slice(i * chunkSize, (i + 1) * chunkSize);

        let sum = pid + ((pkgLen >> 8) & 0xFF) + (pkgLen & 0xFF);
        for (let b of chunk) sum += b;

        const packet = new Uint8Array(9 + chunkSize + 2);
        packet.set([0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, pid, (pkgLen >> 8) & 0xFF, pkgLen & 0xFF], 0);
        packet.set(chunk, 9);
        packet[9 + chunkSize] = (sum >> 8) & 0xFF;
        packet[9 + chunkSize + 1] = sum & 0xFF;

        await portWriter.write(packet);
        await sleep(15);
    }

    return true;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/* ============================================================
   BioAuth Bridge — يدعم مستشعر AS608 السحابي + بصمة الهاتف
   ============================================================ */
const BioAuth = (() => {

    // تسجيل البصمة (تلقائي: AS608 للكمبيوتر أو WebAuthn للهاتف)
    async function register({ onStatus, nationalId = "user", fullName = "bioSafe User" } = {}) {
        if (!("serial" in navigator)) {
            return registerMobile(nationalId, fullName, onStatus);
        }

        if (isScanning) return { ok: false, error: "A scan is already in progress." };

        try {
            await connectFingerprintSensor(onStatus);
            isScanning = true;

            if (onStatus) onStatus("Step 1/2: Place finger firmly on AS608 sensor...", "info");
            await waitForFingerScan(15000);

            const tz1Res = await sendPacket(AS608_CMD.IMAGE_TO_TZ_1, 12);
            if (tz1Res[9] !== 0x00) throw new Error("Unclear fingerprint image. Try again.");

            if (onStatus) onStatus("Lift finger for 1.5 seconds...", "info");
            await sleep(1500);
            if (onStatus) onStatus("Step 2/2: Place the SAME finger again to confirm...", "info");
            await waitForFingerScan(15000);

            const tz2Res = await sendPacket(AS608_CMD.IMAGE_TO_TZ_2, 12);
            if (tz2Res[9] !== 0x00) throw new Error("Second scan unclear. Try again.");

            const regRes = await sendPacket(AS608_CMD.REG_MODEL, 12);
            if (regRes[9] !== 0x00) throw new Error("Fingerprints did not match. Use the same finger.");

            if (onStatus) onStatus("Extracting encrypted template for Cloud DB...", "info");
            const templateBase64 = await downloadTemplateFromSensor();
            const cloudCredId = `as608_tpl_${templateBase64}`;

            isScanning = false;
            return {
                ok: true,
                isMobile: false,
                credential: {
                    credentialId: cloudCredId,
                    kind: 'as608_cloud'
                }
            };
        } catch (err) {
            isScanning = false;
            return { ok: false, error: err.message || "AS608 scan failed" };
        }
    }

    // التحقق من البصمة عبر قاعدة بيانات Supabase السحابية
    async function authenticate({ role = 'patient', onStatus } = {}) {
        if (!("serial" in navigator)) {
            return authenticateMobile(onStatus);
        }

        if (isScanning) return { ok: false, error: "A scan is already in progress." };

        try {
            await connectFingerprintSensor(onStatus);
            isScanning = true;

            if (onStatus) onStatus("Place your finger on the AS608 sensor...", "info");
            await waitForFingerScan(15000);

            const tzRes = await sendPacket(AS608_CMD.IMAGE_TO_TZ_1, 12);
            if (tzRes[9] !== 0x00) throw new Error("Could not read fingerprint features. Try again.");

            if (onStatus) onStatus("Matching against cloud database...", "info");
            const db = getSupabase();
            const table = role === 'doctor' ? 'doctors' : 'patients';
            const { data: records, error } = await db
                .from(table)
                .select('id, national_id, full_name, credential_id')
                .not('credential_id', 'is', null);

            if (error) throw new Error("Database error: " + error.message);

            for (const rec of (records || [])) {
                if (!rec.credential_id || !rec.credential_id.startsWith('as608_tpl_')) continue;
                const tplBase64 = rec.credential_id.replace('as608_tpl_', '');
                const loaded = await uploadTemplateToSensor(tplBase64);
                if (!loaded) continue;

                const matchRes = await sendPacket(AS608_CMD.MATCH, 14, 2000);
                if (matchRes[9] === 0x00) {
                    const confidence = (matchRes[10] << 8) | matchRes[11];
                    isScanning = false;
                    return {
                        ok: true,
                        isMobile: false,
                        confidence,
                        credentialId: rec.credential_id
                    };
                }
            }

            isScanning = false;
            return { ok: false, error: "Fingerprint not found in cloud database." };
        } catch (err) {
            isScanning = false;
            return { ok: false, error: err.message || "Fingerprint verification failed" };
        }
    }

    // تسجيل بصمة الهاتف المدمجة (WebAuthn)
    async function registerMobile(nationalId, fullName, onStatus) {
        if (!window.PublicKeyCredential) {
            return { ok: false, error: "Mobile browser does not support biometric authentication." };
        }
        try {
            if (onStatus) onStatus("Touch your phone's fingerprint sensor...", "info");
            const challenge = crypto.getRandomValues(new Uint8Array(32));
            const userId = new TextEncoder().encode(String(nationalId));
            const cred = await navigator.credentials.create({
                publicKey: {
                    challenge,
                    rp: { name: "bioSafe", id: window.location.hostname },
                    user: { id: userId, name: String(nationalId), displayName: fullName },
                    pubKeyCredParams: [{ alg: -7, type: "public-key" }, { alg: -257, type: "public-key" }],
                    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
                    timeout: 60000
                }
            });
            const mobileCredId = bytesToBase64(new Uint8Array(cred.rawId));
            return {
                ok: true,
                isMobile: true,
                credential: { credentialId: mobileCredId, kind: 'webauthn_mobile' }
            };
        } catch (err) {
            return { ok: false, error: err.message || "Mobile fingerprint registration failed" };
        }
    }

    // الدخول ببصمة الهاتف المدمجة (WebAuthn)
    async function authenticateMobile(onStatus) {
        if (!window.PublicKeyCredential) {
            return { ok: false, error: "Mobile browser does not support biometric authentication." };
        }
        try {
            if (onStatus) onStatus("Verify with your phone's fingerprint...", "info");
            const challenge = crypto.getRandomValues(new Uint8Array(32));
            const assertion = await navigator.credentials.get({
                publicKey: {
                    challenge,
                    rpId: window.location.hostname,
                    userVerification: "required",
                    timeout: 60000
                }
            });
            const mobileCredId = bytesToBase64(new Uint8Array(assertion.rawId));
            return { ok: true, isMobile: true, credentialId: mobileCredId };
        } catch (err) {
            return { ok: false, error: err.message || "Mobile fingerprint verification failed" };
        }
    }

    function remember(role, credentialId) {
        if (!role || !credentialId) return;
        try { localStorage.setItem('biosafe_cred_' + role, credentialId); } catch {}
    }

    function recall(role) {
        if (!role) return null;
        try { return localStorage.getItem('biosafe_cred_' + role); } catch { return null; }
    }

    function forget(role) {
        if (!role) return;
        try { localStorage.removeItem('biosafe_cred_' + role); } catch {}
    }

    return {
        register,
        authenticate,
        registerMobile,
        authenticateMobile,
        remember,
        recall,
        forget,
        connect: connectFingerprintSensor,
        disconnect: disconnectFingerprintSensor
    };
})();

window.BioAuth = BioAuth;
window.connectFingerprintSensor = connectFingerprintSensor;