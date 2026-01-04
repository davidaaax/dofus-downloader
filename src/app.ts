const axios = require('axios');
const fse = require('fs-extra');
const fs = require('fs');
const Path = require('path');
const pb = require('progress');
const crypto = require('crypto');
const pLimit = require('p-limit');

import * as figlet from 'figlet';
import colors from 'colors';

require('dotenv').config();

const CONCURRENT_DOWNLOADS = 30;
const MAX_RETRIES = 3;


export default class App {

    private version: string;
    private majorVersion: number;
    private minorVersion: number;
    private platforms: string[];
    private findVersion: boolean = false;

    constructor() {
        this.version = process.env.VERSION!;
        this.majorVersion = 12;
        this.minorVersion = 31;
        this.platforms = process.env.PLATFORMS!.split(',').map(p => p.trim());
        this.init();
    }

    public init(): void {
        console.log(colors.blue(figlet.textSync(process.env.npm_package_name!, {
            horizontalLayout: 'full',
            verticalLayout: 'default',
            whitespaceBreak: true
        })));
        console.log(colors.yellow(`Description : ${process.env.npm_package_description}`));
        console.log(colors.yellow(`Version : ${process.env.npm_package_version}`));
        console.log("");
        console.log("");

        this.startSearch();
        return;
    }

    public async startSearch() {
        console.log(colors.green('Connecting...'));
        const searchPlatform = this.platforms[0];

        while (!this.findVersion) {
            try {
                console.log(colors.cyan(`Searching version ${this.version}.${this.majorVersion}.${this.minorVersion}...`));
                const response = await axios.get(`https://launcher.cdn.ankama.com/dofus/releases/main/${searchPlatform}/5.0_${this.version}.${this.majorVersion}.${this.minorVersion}.json`);
                await fse.outputFile(`tmp/${this.version}.${this.majorVersion}.${this.minorVersion}.json`, JSON.stringify(response.data));
                console.log(colors.green(`Version found: ${this.version}.${this.majorVersion}.${this.minorVersion}`));
                this.findVersion = true;
            } catch (err) {
                console.log(colors.red(`No version found for ${this.version}.${this.majorVersion}.${this.minorVersion}`));
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

        // Download for all platforms
        for (const platform of this.platforms) {
            await this.downloadFilesForPlatform(platform);
        }
    }
    
    public async checksumFile(hashName:string, path:string) {
        return new Promise((resolve, reject) => {
          const hash = crypto.createHash(hashName);
          const stream = fs.createReadStream(path);
          stream.on('error', (err: any) => reject(err));
          stream.on('data', (chunk: any) => hash.update(chunk));
          stream.on('end', () => resolve(hash.digest('hex')));
        });
    }

    public async downloadFilesForPlatform(platform: string) {
        console.log(colors.green(`\nDownloading ${this.version}.${this.majorVersion}.${this.minorVersion} for ${platform}...`));

        // Fetch manifest for this platform
        const response = await axios.get(`https://launcher.cdn.ankama.com/dofus/releases/main/${platform}/5.0_${this.version}.${this.majorVersion}.${this.minorVersion}.json`);
        const manifest = response.data;

        // Collect all files from all sections
        const limit = pLimit(CONCURRENT_DOWNLOADS);
        const filesToDownload: { filename: string; hash: string }[] = [];

        for (const section in manifest) {
            const files = manifest[section].files;
            if (!files) continue;

            for (let filename in files) {
                const hash = files[filename]['hash'];
                const path = Path.resolve(__dirname, `../output/${this.version}.${this.majorVersion}.${this.minorVersion}/${platform}`, filename);

                if (!fs.existsSync(path)) {
                    filesToDownload.push({ filename, hash });
                } else {
                    try {
                        const existingHash = await this.checksumFile('sha1', path);
                        if (existingHash !== hash) {
                            filesToDownload.push({ filename, hash });
                        }
                    } catch {
                        filesToDownload.push({ filename, hash });
                    }
                }
            }
        }

        const totalFiles = filesToDownload.length;
        if (totalFiles === 0) {
            console.log(colors.green(`All files for ${platform} already downloaded!`));
            return;
        }

        console.log(colors.cyan(`${totalFiles} files to download (${CONCURRENT_DOWNLOADS} parallel)`));

        let completed = 0;
        let failed = 0;

        const progressBar = new pb(colors.green(`[${platform}] [:bar]`) + colors.blue(' :percent') + colors.yellow(' :current/:total') + colors.cyan(' :etas'), {
            width: 30,
            complete: '=',
            incomplete: ' ',
            total: totalFiles
        });

        // Download files in parallel with concurrency limit
        await Promise.all(
            filesToDownload.map(({ filename, hash }) =>
                limit(async () => {
                    const success = await this.downloadFileWithRetry(filename, hash, platform);
                    if (success) {
                        completed++;
                    } else {
                        failed++;
                    }
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

    private async downloadFileWithRetry(filename: string, hash: string, platform: string): Promise<boolean> {
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                await this.downloadFile(filename, hash, platform);
                return true;
            } catch (err: any) {
                if (attempt < MAX_RETRIES) {
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                }
            }
        }
        return false;
    }

    public async downloadFile(filename: string, hash: string, platform: string): Promise<void> {
        const url = 'https://launcher.cdn.ankama.com/dofus/hashes/' + hash.substring(0, 2) + '/' + hash;
        const path = Path.resolve(__dirname, `../output/${this.version}.${this.majorVersion}.${this.minorVersion}/${platform}`, filename);
        const dirname = Path.dirname(path);
        fs.mkdirSync(dirname, { recursive: true });
        const writer = fs.createWriteStream(path);

        const { data } = await axios({
            url,
            method: 'GET',
            responseType: 'stream'
        });

        return new Promise((resolve, reject) => {
            data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    }
}

const app = new App();
