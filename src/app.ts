const axios = require('axios');
const fse = require('fs-extra');
const fs = require('fs');
const Path = require('path');
const pb = require('progress');

import * as figlet from 'figlet';
import colors from 'colors';

require('dotenv').config();


export default class App {

    private version: string;
    private majorVersion: number;
    private minorVersion: number;
    private plateform: string;
    private findVersion: boolean = false;

    constructor() {
        this.version = process.env.VERSION!;
        this.majorVersion = parseInt(process.env.MAJOR_VERSION!);
        this.minorVersion = parseInt(process.env.MINOR_VERSION!);
        this.plateform = process.env.PLATEFORM!;
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
        while (!this.findVersion) {
            try {
                console.log(colors.cyan(`Searching version ${this.version}.${this.majorVersion}.${this.minorVersion}...`));
                const response = await axios.get('https://launcher.cdn.ankama.com/dofus/releases/main/' + this.plateform + '/5.0_' + this.version + '.' + this.majorVersion + '.' + this.minorVersion + '.json');
                await fse.outputFile('tmp/' + this.version + '.' + this.majorVersion + '.' + this.minorVersion + '.json', JSON.stringify(response.data));
                console.log(colors.green(`Version found for ${this.version}.${this.majorVersion}.${this.minorVersion} !`));
                this.findVersion = true;
            } catch (err) {
                console.log(colors.red(`No version found for ${this.version}.${this.majorVersion}.${this.minorVersion}`));
                this.minorVersion++;
                if (this.minorVersion >= 50) {
                    this.minorVersion = 0;
                    this.majorVersion++;
                }
            }
        }

        this.downloadFiles();
    }

    public async downloadFiles() {
        console.log(colors.green(`Starting download ${this.version}.${this.majorVersion}.${this.minorVersion}...`));
        const json = fse.readJsonSync('tmp/' + this.version + '.' + this.majorVersion + '.' + this.minorVersion + '.json');
        const files = json.main.files;
        for (let filename in files) {
            const hash = files[filename]['hash'];
            const response = await this.downloadFile(filename, hash);
        }
        console.log(colors.green('Downloading finished !'));
        return;
    }

    public async downloadFile(filename: string, hash: string) {
        const url = 'https://launcher.cdn.ankama.com/dofus/hashes/' + hash.substring(0, 2) + '/' + hash;
        const path = Path.resolve(__dirname, `../tmp/client-${this.plateform}-${this.version}.${this.majorVersion}.${this.minorVersion}`, filename);
        const dirname = Path.dirname(path);
        fs.mkdirSync(dirname, { recursive: true });
        const writer = fs.createWriteStream(path);
        const { data, headers } = await axios({
            url,
            method: 'GET',
            responseType: 'stream'
        });
        const totalLength = headers['content-length'];
        const progressBar = new pb(colors.yellow('downloading ' + Path.basename(filename)) + colors.green(' [:bar]') + colors.blue(' :percent :etas'), {
            width: 40,
            complete: '=',
            incomplete: ' ',
            renderThrottle: 1,
            total: parseInt(totalLength)
        });
        data.on('data', (chunk: any) => progressBar.tick(chunk.length));
        data.pipe(writer);
    }
}

const app = new App();