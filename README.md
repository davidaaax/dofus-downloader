# Dofus-Downloader

Dofus Downloader is a tool that allows you to download all versions of Dofus 2.X through the CDN of the official launcher.

The tool is configured by default to download version 2.62.
You can change the platform as well as the version to download by modifying the **.env** file.

## Requirements

- [Node.js](https://nodejs.org/) v8+
- Git
- Linux / Mac / Windows


## Installation

Dofus-Downloader requires [Node.js](https://nodejs.org/) v8+ to run.

Install the dependencies and devDependencies and start the server.

```sh
cd dofus-downloader
npm i
npm run start
```

Variables environments...

```sh
PLATEFORM=darwin
VERSION=2.62
MAJOR_VERSION=0
MINOR_VERSION=0
```

⚠️ Plateform : windows / darwin (mac) / linux

⚠️ Leave the minor and major versions at 0 if you don't know which version to download

## Output

The version you downloaded is in **/tmp/client-$plateform-$version**.
