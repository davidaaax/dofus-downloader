import axios from 'axios';
import * as flatbuffers from 'flatbuffers';
import * as fse from 'fs-extra';
import * as fs from 'fs';
import * as Path from 'path';
import colors from 'colors';
import * as figlet from 'figlet';

const pLimit = require('p-limit');
const pb = require('progress');

import { Manifest } from './flatbuffers/manifest';
import { Fragment } from './flatbuffers/fragment';
import { File as ManifestFile } from './flatbuffers/file';
import { Bundle } from './flatbuffers/bundle';
import { Chunk } from './flatbuffers/chunk';

require('dotenv').config();

const CONCURRENT_DOWNLOADS = 30;
const MAX_RETRIES = 3;
const CDN_BASE = 'https://cytrus.cdn.ankama.com';

interface FileInfo {
    name: string;
    size: bigint;
    hash: string;
    executable: boolean;
    chunks: ChunkInfo[];
}

interface ChunkInfo {
    hash: string;
    size: bigint;
    offset: bigint;
}

interface BundleInfo {
    hash: string;
    chunks: Map<string, { size: bigint; offset: bigint }>;
}

function hashToHex(hashArray: Int8Array | null): string {
    if (!hashArray) return '';
    return Array.from(new Uint8Array(hashArray.buffer, hashArray.byteOffset, hashArray.length))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

class AppV6 {
    private game: string;
    private release: string;
    private platforms: string[];
    private baseVersion: string;
    private majorVersion: number = 12;
    private minorVersion: number = 31;
    private version: string | null = null;

    constructor() {
        this.game = process.env.GAME || 'dofus';
        this.release = process.env.RELEASE || 'main';
        this.platforms = (process.env.PLATFORMS || 'windows').split(',').map(p => p.trim());
        this.baseVersion = process.env.VERSION || '2.70';
        this.init();
    }

    private init(): void {
        console.log(colors.blue(figlet.textSync('Dofus DL v6', {
            horizontalLayout: 'full',
            verticalLayout: 'default',
            whitespaceBreak: true
        })));
        console.log(colors.yellow(`Game: ${this.game} | Release: ${this.release}`));
        console.log(colors.yellow(`Platforms: ${this.platforms.join(', ')}`));
        console.log('');

        this.start();
    }

    private async start() {
        try {
            // Search for version like v5
            console.log(colors.green('Searching for version...'));
            const platform = this.platforms[0];

            while (!this.version) {
                const testVersion = `6.0_${this.baseVersion}.${this.majorVersion}.${this.minorVersion}`;
                const manifestUrl = `${CDN_BASE}/${this.game}/releases/${this.release}/${platform}/${testVersion}.manifest`;

                try {
                    console.log(colors.cyan(`Testing ${testVersion}...`));
                    await axios.head(manifestUrl);
                    this.version = testVersion;
                    console.log(colors.green(`Version found: ${this.version}`));
                } catch (err) {
                    this.minorVersion--;
                    if (this.minorVersion < 0) {
                        this.minorVersion = 31;
                        this.majorVersion--;
                        if (this.majorVersion < 0) {
                            console.log(colors.red('No version found after checking all possible dates'));
                            return;
                        }
                    }
                }
            }

            // Download for each platform
            for (const plat of this.platforms) {
                await this.downloadForPlatform(plat);
            }

            console.log(colors.green('\nAll downloads completed!'));
        } catch (err: any) {
            console.log(colors.red(`Error: ${err.message}`));
        }
    }

    private async downloadForPlatform(platform: string) {
        console.log(colors.cyan(`\n=== Downloading for ${platform} ===`));

        // Fetch manifest
        const manifestUrl = `${CDN_BASE}/${this.game}/releases/${this.release}/${platform}/${this.version}.manifest`;
        console.log(colors.green(`Fetching manifest...`));

        const response = await axios.get(manifestUrl, { responseType: 'arraybuffer' });
        const manifestData = new Uint8Array(response.data);

        // Parse manifest
        const bb = new flatbuffers.ByteBuffer(manifestData);
        const manifest = Manifest.getRootAsManifest(bb);

        // Collect all files and bundles
        const allFiles: FileInfo[] = [];
        const allBundles: Map<string, BundleInfo> = new Map();

        const fragmentCount = manifest.fragmentsLength();
        console.log(colors.cyan(`Found ${fragmentCount} fragments`));

        for (let i = 0; i < fragmentCount; i++) {
            const fragment = manifest.fragments(i);
            if (!fragment) continue;

            const fragmentName = fragment.name() || 'unknown';

            // Collect files
            const fileCount = fragment.filesLength();
            for (let j = 0; j < fileCount; j++) {
                const file = fragment.files(j);
                if (!file) continue;

                const fileInfo: FileInfo = {
                    name: file.name() || '',
                    size: file.size(),
                    hash: hashToHex(file.hashArray()),
                    executable: file.executable(),
                    chunks: []
                };

                const chunkCount = file.chunksLength();
                for (let k = 0; k < chunkCount; k++) {
                    const chunk = file.chunks(k);
                    if (!chunk) continue;

                    fileInfo.chunks.push({
                        hash: hashToHex(chunk.hashArray()),
                        size: chunk.size(),
                        offset: chunk.offset()
                    });
                }

                allFiles.push(fileInfo);
            }

            // Collect bundles
            const bundleCount = fragment.bundlesLength();
            for (let j = 0; j < bundleCount; j++) {
                const bundle = fragment.bundles(j);
                if (!bundle) continue;

                const bundleHash = hashToHex(bundle.hashArray());
                const bundleInfo: BundleInfo = {
                    hash: bundleHash,
                    chunks: new Map()
                };

                const chunkCount = bundle.chunksLength();
                for (let k = 0; k < chunkCount; k++) {
                    const chunk = bundle.chunks(k);
                    if (!chunk) continue;

                    bundleInfo.chunks.set(hashToHex(chunk.hashArray()), {
                        size: chunk.size(),
                        offset: chunk.offset()
                    });
                }

                allBundles.set(bundleHash, bundleInfo);
            }
        }

        console.log(colors.cyan(`Total: ${allFiles.length} files, ${allBundles.size} bundles`));

        // Create chunk -> bundle mapping
        const chunkToBundleMap: Map<string, { bundleHash: string; offset: bigint; size: bigint }> = new Map();
        for (const [bundleHash, bundleInfo] of allBundles) {
            for (const [chunkHash, chunkData] of bundleInfo.chunks) {
                chunkToBundleMap.set(chunkHash, {
                    bundleHash,
                    offset: chunkData.offset,
                    size: chunkData.size
                });
            }
        }

        // Download and reconstruct files
        const outputDir = Path.resolve(__dirname, `../output/${this.version}/${platform}`);
        const limit = pLimit(CONCURRENT_DOWNLOADS);

        // Filter files that need downloading
        const filesToDownload: FileInfo[] = [];
        for (const file of allFiles) {
            const filePath = Path.join(outputDir, file.name);
            if (!fs.existsSync(filePath)) {
                filesToDownload.push(file);
            }
        }

        if (filesToDownload.length === 0) {
            console.log(colors.green(`All files already downloaded!`));
            return;
        }

        console.log(colors.cyan(`${filesToDownload.length} files to download`));

        let completed = 0;
        let failed = 0;

        const progressBar = new pb(
            colors.green(`[${platform}] [:bar]`) + colors.blue(' :percent') + colors.yellow(' :current/:total') + colors.cyan(' :etas'),
            { width: 30, complete: '=', incomplete: ' ', total: filesToDownload.length }
        );

        await Promise.all(
            filesToDownload.map(file =>
                limit(async () => {
                    const success = await this.downloadFile(file, chunkToBundleMap, outputDir);
                    if (success) completed++;
                    else failed++;
                    progressBar.tick();
                })
            )
        );

        console.log('');
        if (failed > 0) {
            console.log(colors.yellow(`${platform}: ${completed} downloaded, ${failed} failed.`));
        } else {
            console.log(colors.green(`${platform}: ${completed} files downloaded.`));
        }
    }

    private async downloadFile(
        file: FileInfo,
        chunkToBundleMap: Map<string, { bundleHash: string; offset: bigint; size: bigint }>,
        outputDir: string
    ): Promise<boolean> {
        const filePath = Path.join(outputDir, file.name);
        const dirPath = Path.dirname(filePath);

        try {
            await fse.ensureDir(dirPath);

            // Collect all data for this file
            const fileBuffer = Buffer.alloc(Number(file.size));
            let writeOffset = 0;

            for (const chunk of file.chunks) {
                const bundleInfo = chunkToBundleMap.get(chunk.hash);
                if (!bundleInfo) {
                    throw new Error(`Bundle not found for chunk ${chunk.hash}`);
                }

                // Download chunk from bundle using range request
                const bundleUrl = `${CDN_BASE}/${this.game}/bundles/${bundleInfo.bundleHash.slice(0, 2)}/${bundleInfo.bundleHash}`;
                const rangeStart = Number(bundleInfo.offset);
                const rangeEnd = rangeStart + Number(chunk.size) - 1;

                for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                    try {
                        const response = await axios.get(bundleUrl, {
                            headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
                            responseType: 'arraybuffer'
                        });

                        const chunkData = Buffer.from(response.data);
                        chunkData.copy(fileBuffer, writeOffset);
                        writeOffset += chunkData.length;
                        break;
                    } catch (err) {
                        if (attempt === MAX_RETRIES) throw err;
                        await new Promise(r => setTimeout(r, 1000 * attempt));
                    }
                }
            }

            await fse.writeFile(filePath, fileBuffer);

            if (file.executable) {
                await fse.chmod(filePath, 0o755);
            }

            return true;
        } catch (err: any) {
            return false;
        }
    }
}

new AppV6();
