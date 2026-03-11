import './polyfills.js';

// 1. GLOBAL STATE & UTILS
let bip32, bip39, bitcoin, ecc;
const systemStatus = document.getElementById('system-status');
const debugOutput = document.getElementById('debug-output');

function logDebug(msg, isError = false) {
    if (debugOutput) {
        if (debugOutput.textContent === 'Wait for polyfills...') debugOutput.innerHTML = '';
        const entry = document.createElement('div');
        entry.className = isError ? 'debug-entry debug-error' : 'debug-entry';
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        debugOutput.appendChild(entry);
        debugOutput.scrollTop = debugOutput.scrollHeight;
    }
    console.log(`[DEBUG] ${msg}`);
}

function updateStatus(msg, type = 'ready') {
    if (systemStatus) {
        systemStatus.textContent = `System: ${msg}`;
        systemStatus.className = `system-status ${type}`;
    }
}

// 2. SECURE ADDRESS GENERATION (Manual bypass)
function deriveLegacyAddress(pubkey) {
    const hash = bitcoin.crypto.hash160(pubkey);
    return bitcoin.address.toBase58Check(hash, 0x00);
}

function deriveNestedAddress(pubkey) {
    const hash = bitcoin.crypto.hash160(pubkey);
    const witnessScript = Buffer.concat([Buffer.from([0x00, 0x14]), hash]);
    const scriptHash = bitcoin.crypto.hash160(witnessScript);
    return bitcoin.address.toBase58Check(scriptHash, 0x05);
}

function deriveNativeAddress(pubkey) {
    const hash = bitcoin.crypto.hash160(pubkey);
    return bitcoin.address.toBech32(hash, 0x00, 'bc');
}

// 3. DYNAMIC INITIALIZATION
let isInitialized = false;
async function initializeApp() {
    if (isInitialized) return;
    isInitialized = true;

    try {
        updateStatus('Pollyfilling...', 'loading');
        logDebug('Ensuring Buffer exists...');

        let attempts = 0;
        while (typeof Buffer === 'undefined' && typeof window.Buffer === 'undefined' && attempts < 5) {
            logDebug(`Buffer missing, waiting (attempt ${attempts + 1}/5)...`, true);
            await new Promise(r => setTimeout(r, 600));
            attempts++;
        }

        if (typeof Buffer === 'undefined' && typeof window.Buffer === 'undefined') {
            throw new Error('Buffer polyfill FAILED to load. Addresses cannot be generated.');
        }
        logDebug('Buffer is ready');

        updateStatus('Loading Modules...', 'loading');
        logDebug('Importing cryptography libraries...');

        const [bip39Mod, bip32Mod, eccMod, bjsMod] = await Promise.all([
            import('bip39'),
            import('bip32'),
            import('tiny-secp256k1'),
            import('bitcoinjs-lib')
        ]);

        bip39 = bip39Mod;
        bitcoin = bjsMod;
        const BIP32Factory = bip32Mod.BIP32Factory;

        logDebug('Searching for ECC discovery...');
        function findEcc(obj, depth = 0) {
            if (!obj || depth > 3) return null;
            // Check for the most critical functions
            if (typeof obj.isPoint === 'function' &&
                typeof obj.pointFromScalar === 'function' &&
                typeof obj.privateAdd === 'function') return obj;

            const targets = ['default', 'ecc', 'secp256k1'];
            for (const t of targets) {
                const found = findEcc(obj[t], depth + 1);
                if (found) return found;
            }
            return null;
        }

        const eccLib = findEcc(eccMod);
        if (!eccLib) {
            logDebug('ECC library keys found: ' + Object.keys(eccMod).join(', '));
            throw new Error('ECC discovery failed - Library structure unknown');
        }
        logDebug('ECC engine found');

        // Verify the engine works before wrapping
        try {
            const testP = eccLib.isPoint(new Uint8Array(33));
            logDebug(`ECC Test (isPoint): ${testP}`);
        } catch (e) {
            logDebug('ECC engine test failed: ' + e.message, true);
        }

        logDebug('Building BIP32 and Hooks...');
        bip32 = BIP32Factory(eccLib);
        bitcoin.initEccLib(eccLib);

        logDebug('Performing self-test derivation...');
        const testSeed = Buffer.alloc(64);
        bip32.fromSeed(testSeed);

        logDebug('Engine fully initialized');
        updateStatus('Ready', 'ready');
        setupUIHandlers();
    } catch (err) {
        logDebug(`CRITICAL FAILURE: ${err.message}`, true);
        console.error(err);
        updateStatus(`Engine Error: ${err.message}`, 'error');
        // Allow re-init if it was a transient failure
        isInitialized = false;
    }
}

// 4. UI LOGIC
let currentWallet = null;
let isSearching = false;
let walletsScanned = 0;
let scanHistory = [];

function setupUIHandlers() {
    const generateBtn = document.getElementById('generate-btn');
    const autoBtn = document.getElementById('auto-btn');
    const toggleKeyBtn = document.getElementById('toggle-key');
    const copyBtns = document.querySelectorAll('.copy-btn');

    generateBtn.addEventListener('click', () => generateWallet(false));
    autoBtn.addEventListener('click', () => isSearching ? stopSearch() : startSearch());

    toggleKeyBtn.addEventListener('click', () => {
        const privateKeyField = document.getElementById('privatekey-field');
        privateKeyField.classList.toggle('revealed');
        toggleKeyBtn.textContent = privateKeyField.classList.contains('revealed') ? '🙈' : '👁️';
    });

    copyBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = document.getElementById(btn.dataset.target);
            const text = target.tagName === 'INPUT' ? target.value : target.textContent;
            if (text && !text.includes('...')) {
                navigator.clipboard.writeText(text).then(() => {
                    const old = btn.textContent;
                    btn.textContent = 'Copied!';
                    setTimeout(() => btn.textContent = old, 1500);
                });
            }
        });
    });
}

const delay = ms => new Promise(res => setTimeout(res, ms));

async function fetchBalance(address, retries = 2) {
    const apis = [
        `https://mempool.space/api/address/${address}`,
        `https://blockstream.info/api/address/${address}`
    ];
    
    for (const url of apis) {
        try {
            // Add a small delay to avoid hammering the APIs too fast
            await delay(1500); 
            
            const res = await fetch(url);
            if (res.status === 429) {
                logDebug(`Rate limited by ${url}. Waiting...`, true);
                await delay(3000); // Wait longer if strict rate limit hit
                continue; // Try next API
            }
            if (res.ok) {
                const data = await res.json();
                const sats = (data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum) +
                             (data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum);
                return (sats / 100000000).toFixed(8);
            }
        } catch (e) {
            logDebug(`Fetch error for ${address} on ${url}: ${e.message}`, true);
        }
    }
    
    if (retries > 0) {
        logDebug(`Retrying balance fetch for ${address}...`);
        await delay(2000);
        return fetchBalance(address, retries - 1);
    }
    
    // If all fails, assume 0 so the loop doesn't freeze forever
    return '0.00000000'; 
}

async function generateWallet(updateCounter = false) {
    try {
        const generateBtn = document.getElementById('generate-btn');
        if (!isSearching && !updateCounter) {
            generateBtn.classList.add('loading');
            generateBtn.disabled = true;
        }

        const mnemonic = bip39.generateMnemonic();
        const seed = await bip39.mnemonicToSeed(mnemonic);
        const root = bip32.fromSeed(seed);

        const child44 = root.derivePath("m/44'/0'/0'/0/0");
        const child49 = root.derivePath("m/49'/0'/0'/0/0");
        const child84 = root.derivePath("m/84'/0'/0'/0/0");

        currentWallet = {
            mnemonic,
            addresses: {
                legacy: deriveLegacyAddress(child44.publicKey),
                nested: deriveNestedAddress(child49.publicKey),
                native: deriveNativeAddress(child84.publicKey)
            },
            privateKeys: {
                legacy: child44.toWIF(),
                nested: child49.toWIF(),
                native: child84.toWIF()
            }
        };

        if (updateCounter) {
            walletsScanned++;
            const scanCountSpan = document.querySelector('#scan-counter span');
            if (scanCountSpan) scanCountSpan.textContent = walletsScanned;
        }

        updateUI();

        const [b1, b2, b3] = await Promise.all([
            fetchBalance(currentWallet.addresses.legacy),
            fetchBalance(currentWallet.addresses.nested),
            fetchBalance(currentWallet.addresses.native)
        ]);

        const total = parseFloat(b1) + parseFloat(b2) + parseFloat(b3);
        currentWallet.balance = total.toFixed(8) + ' BTC';
        updateUI();

        scanHistory.unshift({
            address: currentWallet.addresses.native,
            balance: total
        });
        if (scanHistory.length > 5) scanHistory.pop();
        updateHistoryUI();

        // If the total balance is greater than exactly 0.00000000 BTC, stop immediately.
        if (total > 0.00000000) {
            stopSearch();
            alert(`🚨 SUCCESS! Found wallet with positive balance: ${currentWallet.balance} 🚨`);
            return true; // Tells the auto-search loop to break
        }
        return false;
    } catch (err) {
        logDebug(`Derivation Error: ${err.message}`, true);
        return false;
    } finally {
        const generateBtn = document.getElementById('generate-btn');
        if (!isSearching) {
            generateBtn.classList.remove('loading');
            generateBtn.disabled = false;
        }
    }
}

async function startSearch() {
    if (isSearching) return;
    isSearching = true;
    const autoBtn = document.getElementById('auto-btn');
    const generateBtn = document.getElementById('generate-btn');
    autoBtn.classList.add('active');
    autoBtn.querySelector('.btn-text').textContent = 'Stop Search';
    generateBtn.disabled = true;

    while (isSearching) {
        const found = await generateWallet(true);
        if (found) break;
        await new Promise(r => setTimeout(r, 1000));
    }
}

function stopSearch() {
    isSearching = false;
    const autoBtn = document.getElementById('auto-btn');
    const generateBtn = document.getElementById('generate-btn');
    autoBtn.classList.remove('active');
    autoBtn.querySelector('.btn-text').textContent = 'Start Auto-Search';
    generateBtn.disabled = false;
}

function updateUI() {
    if (!currentWallet) return;
    document.getElementById('mnemonic-field').textContent = currentWallet.mnemonic;
    document.getElementById('mnemonic-field').classList.remove('placeholder');

    document.getElementById('address-legacy').value = currentWallet.addresses.legacy;
    document.getElementById('address-nested').value = currentWallet.addresses.nested;
    document.getElementById('address-native').value = currentWallet.addresses.native;

    ['address-legacy', 'address-nested', 'address-native'].forEach(id => {
        document.getElementById(id).classList.remove('placeholder');
    });

    const balanceField = document.getElementById('balance-field');
    balanceField.textContent = currentWallet.balance || 'Checking...';
    balanceField.classList.remove('placeholder');

    const privateKeyField = document.getElementById('privatekey-field');
    privateKeyField.textContent = currentWallet.privateKeys.native;
    privateKeyField.classList.remove('placeholder');
}

function updateHistoryUI() {
    const historyList = document.getElementById('history-list');
    if (!historyList) return;

    if (scanHistory.length === 0) {
        historyList.innerHTML = '<li class="history-empty">No scans yet</li>';
        return;
    }

    historyList.innerHTML = '';
    scanHistory.forEach(scan => {
        const li = document.createElement('li');
        li.className = 'history-item';

        const addrSpan = document.createElement('span');
        addrSpan.className = 'history-addr';
        // Show just the first and last few characters of the address
        addrSpan.textContent = `${scan.address.slice(0, 8)}...${scan.address.slice(-6)}`;

        const balSpan = document.createElement('span');
        const isZero = scan.balance === 0;
        balSpan.className = `history-bal ${isZero ? 'zero' : 'positive'}`;
        balSpan.textContent = scan.balance.toFixed(8) + ' BTC';

        li.appendChild(addrSpan);
        li.appendChild(balSpan);
        historyList.appendChild(li);
    });
}

// 5. START UP
document.addEventListener('DOMContentLoaded', initializeApp);
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    // Just in case DOMContentLoaded already fired
    initializeApp();
}
