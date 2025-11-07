import Client from 'castv2-client';
import mdns from 'mdns-js';

const { DefaultMediaReceiver } = Client;

/**
 * Discover Chromecast devices on the network
 * @returns {Promise<Array>} Array of discovered devices
 */
export function discoverDevices(timeout = 5000) {
    return new Promise((resolve) => {
        const devices = [];
        const browser = mdns.createBrowser(mdns.tcp('googlecast'));

        const timer = setTimeout(() => {
            browser.stop();
            resolve(devices);
        }, timeout);

        browser.on('ready', () => {
            browser.discover();
        });

        browser.on('update', (service) => {
            if (service.addresses && service.addresses.length > 0) {
                const device = {
                    name: service.txt?.[0] || service.name || 'Unknown Device',
                    host: service.addresses[0],
                    port: service.port || 8009
                };
                
                // Avoid duplicates
                if (!devices.find(d => d.host === device.host)) {
                    devices.push(device);
                    console.log(`[Chromecast] Discovered: ${device.name} at ${device.host}`);
                }
            }
        });
    });
}

/**
 * Cast a media URL to a Chromecast device
 * @param {string} host - Chromecast device IP address
 * @param {string} mediaUrl - URL of the media to cast
 * @param {Object} metadata - Optional metadata (title, images, etc.)
 * @returns {Promise<Object>} Result object with success status
 */
export function castMedia(host, mediaUrl, metadata = {}) {
    return new Promise((resolve, reject) => {
        const client = new Client.Client();

        console.log(`[Chromecast] Attempting to cast:`);
        console.log(`[Chromecast] - Host: ${host}`);
        console.log(`[Chromecast] - Media URL: ${mediaUrl}`);
        console.log(`[Chromecast] - Metadata:`, metadata);

        client.connect(host, () => {
            console.log(`[Chromecast] Connected to ${host}`);

            client.launch(DefaultMediaReceiver, (err, player) => {
                if (err) {
                    client.close();
                    return reject(new Error(`Failed to launch receiver: ${err.message}`));
                }

                console.log(`[Chromecast] DefaultMediaReceiver launched`);

                const media = {
                    contentId: mediaUrl,
                    contentType: metadata.contentType || 'video/mp4',
                    streamType: 'BUFFERED', // Use BUFFERED for regular files, LIVE for livestreams
                    metadata: {
                        type: 0,
                        metadataType: 0,
                        title: metadata.title || 'PlayTorrio Stream',
                        images: metadata.images || []
                    }
                };

                console.log(`[Chromecast] Loading media:`, media);

                player.load(media, { autoplay: true }, (err, status) => {
                    if (err) {
                        console.error(`[Chromecast] Failed to load media:`, err);
                        client.close();
                        return reject(new Error(`Failed to load media: ${err.message}`));
                    }

                    console.log(`[Chromecast] Media loaded successfully`);
                    console.log(`[Chromecast] Status:`, status);

                    // Monitor player status for debugging
                    player.on('status', (status) => {
                        console.log(`[Chromecast] Player status update:`, status);
                    });

                    // Don't close the client immediately - let it continue casting
                    // Client will be closed when user stops casting or app exits
                    resolve({
                        success: true,
                        message: `Casting to Chromecast at ${host}`,
                        player: player,
                        client: client
                    });
                });
            });
        });

        client.on('error', (err) => {
            console.error(`[Chromecast] Client error:`, err);
            client.close();
            reject(new Error(`Chromecast error: ${err.message}`));
        });
    });
}

/**
 * Cast to the first available Chromecast device
 * @param {string} mediaUrl - URL of the media to cast
 * @param {Object} metadata - Optional metadata
 * @returns {Promise<Object>} Result object
 */
export async function castToFirstDevice(mediaUrl, metadata = {}) {
    console.log('[Chromecast] Discovering devices...');
    const devices = await discoverDevices(3000);

    if (devices.length === 0) {
        throw new Error('No Chromecast devices found on the network');
    }

    console.log(`[Chromecast] Found ${devices.length} device(s)`);
    const device = devices[0];
    console.log(`[Chromecast] Using device: ${device.name} (${device.host})`);

    return await castMedia(device.host, mediaUrl, metadata);
}

/**
 * Stop casting on a device
 * @param {Object} client - The client object from castMedia
 */
export function stopCasting(client) {
    if (client) {
        try {
            client.close();
            console.log('[Chromecast] Stopped casting');
        } catch (err) {
            console.error('[Chromecast] Error stopping cast:', err);
        }
    }
}
