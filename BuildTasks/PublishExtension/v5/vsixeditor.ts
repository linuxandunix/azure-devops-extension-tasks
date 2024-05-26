import "core-js";
import * as temp from "temp";
import * as fs from "fs";
import * as fse from "fs-extra";
import * as path from "path";
import * as tl from "azure-pipelines-task-lib";
import * as tr from "azure-pipelines-task-lib/toolrunner.js";
import * as common from "vsts-developer-tools.commonv5/Common.js";

interface VsixManifest {
    PackageManifest: {
        Metadata: {
            Identity: {
                _Id: string;
                _Version: string;
                _Publisher: string;
            };
            DisplayName: string;
            GalleryFlags: string;
        };
    };
}

class ManifestData {
    public outputFileName: string;
    constructor(public version: string,
        public id: string,
        public publisher: string,
        public visibility: string,
        public pricing: string,
        public name: string,
        public dirPath: string) { }

    public createOutputFilePath(outputPath: string): string {
        const fileName = `${this.publisher}.${this.id}-${this.version}.gen.vsix`;

        const updateFileName = (fileName: string, iteration: number) => {
            if (iteration > 0) {
                const gen = iteration.toString().padStart(2, "0");
                fileName = `${this.publisher}.${this.id}-${this.version}.gen${gen}.vsix`;
            }
            fs.exists(path.join(outputPath, fileName), result => {
                if (result) {
                    updateFileName(fileName, ++iteration);
                } else {
                    tl.debug("Generated filename: " + fileName);
                }
            });
        };

        updateFileName(fileName, 0);

        return fileName;
    }
}

class GalleryFlagsEditor {
    flags: string[] = [];
    constructor(galleryFlagsEditor: string) {
        if (galleryFlagsEditor) {
            this.flags = galleryFlagsEditor.split(" ").filter(f => f != null && f !== "");
        }
    }

    private addFlag(flag: string) {
        if (this.flags.indexOf(flag) < 0) { this.flags.push(flag); }
    }

    private removeFlag(flag: string) {
        const index = this.flags.indexOf(flag);
        if (index >= 0) { this.flags.splice(index, 1); }
    }

    addPublicFlag() {
        this.addFlag("Public");
    }

    removePublicFlag() {
        this.removeFlag("Public");
    }

    removePaidFlag() {
        this.removeFlag("Paid");
    }

    addPaidFlag() {
        this.addFlag("Paid");
    }

    addPreviewFlag() {
        this.addFlag("Preview");
    }

    removePreviewFlag() {
        this.removeFlag("Preview");
    }

    toString(): string {
        return this.flags.join(" ");
    }
}

export class VSIXEditor {
    private edit = false;
    private versionNumber: string = null;
    private id: string = null;
    private idTag: string = null;
    private publisher: string = null;
    private extensionName: string = null;
    private extensionVisibility: string = null;
    private extensionPricing: string = null;
    private updateTasksVersion = true;
    private updateTasksId = true;

    constructor(
        public inputFile: string,
        public outputPath: string) {
    }

    public startEdit() {
        if (this.edit) { throw new Error("Edit is already started"); }
        this.edit = true;
        tl.debug("Editing started");
    }

    private async extractArchive(vsix: string, tmpPath: string): Promise<void> {
        const cwd = tl.cwd();

        if (tl.getPlatform() === tl.Platform.Windows) {
            const sevenZip = (await import("7zip-bin")).default;
            const zip = new tr.ToolRunner(sevenZip.path7za);

            zip.arg("x");
            zip.arg(vsix);          // file to extract
            zip.arg(`-o${tmpPath}`);  // redirect output to dir
            zip.arg("task.json");
            zip.arg("task.loc.json");
            zip.arg("extension.vsixmanifest");
            zip.arg("extension.vsomanifest");
            zip.arg("-y");           // assume yes on all queries
            zip.arg("-r");           // recurse
            zip.arg("-bd");          // disable progress indicator
            zip.arg("-aoa");         // overwrite all
            zip.arg("-spd");         // disable wildcards
            zip.execSync();
        }
        else {
            const zip = new tr.ToolRunner(tl.which("unzip", true));

            zip.arg("-o");           // overwrite all
            zip.arg("-C");           // match case insensitive
            zip.arg("-d");           // redirect output to
            zip.arg(tmpPath);         // output directory
            zip.arg(vsix);          // file to extract
            zip.arg("*/task.json");
            zip.arg("*/task.loc.json");
            zip.arg("extension.vsixmanifest");
            zip.arg("extension.vsomanifest");
            zip.execSync();
        }
        tl.cd(cwd);
    }

    private async createArchive(originalVsix: string, tmpPath: string, targetVsix: string): Promise<void> {
        const cwd = tl.cwd();

        if (originalVsix !== targetVsix) { tl.cp(originalVsix, targetVsix, "-f"); }

        if (tl.getPlatform() === tl.Platform.Windows) {
            const sevenZip = await import("7zip-bin");
            const zip = new tr.ToolRunner(sevenZip.path7za);

            zip.arg("u");
            zip.arg(targetVsix);         // redirect output to file
            zip.arg(path.join(tmpPath, "\\*"));
            zip.arg("-r");           // recursive
            zip.arg("-y");           // assume yes on all queries
            zip.arg("-tzip");        // zip format
            zip.arg("-mx9");         // max compression level
            zip.arg("-bd");         // disable progress indicator
            zip.execSync();
        }
        else {
            const zip = new tr.ToolRunner(tl.which("zip", true));

            tl.cd(tmpPath);
            zip.arg(path.join(cwd, targetVsix));         // redirect output to file
            zip.arg(".");
            zip.arg("-r");           // recursive
            zip.arg("-9");           // max compression level
            zip.arg("-f");           // update changed files only
            zip.execSync();
        }
        tl.cd(cwd);
    }

    public async endEdit(): Promise<string> {
        this.validateEditMode();

        if (!this.hasEdits()) { return this.inputFile; }

        temp.track();

        const dirPath = await temp.mkdir("vsixeditor");
        tl.debug("Extracting files to " + dirPath);

        await this.extractArchive(this.inputFile, dirPath);
        if (this.versionNumber && this.updateTasksVersion || this.updateTasksId) {
            tl.debug("Look for build tasks manifest");
            const extensionManifest = path.join(dirPath, "extension.vsomanifest");
            await common.checkUpdateTasksManifests(extensionManifest);
        }

        tl.debug("Editing VSIX manifest");
        const manifestData = await this.editVsixManifest(dirPath);
        manifestData.outputFileName = manifestData.createOutputFilePath(this.outputPath);

        tl.debug(`Creating final archive file at ${this.outputPath}`);
        await this.createArchive(this.inputFile, manifestData.dirPath, manifestData.outputFileName);
        tl.debug("Final archive file created");

        return manifestData.outputFileName;
    }

    private async editVsixManifest(dirPath: string): Promise<ManifestData> {
        const x2jsLib = (await import("x2js")).default;
        const x2js = new x2jsLib();

        const vsixManifestPath = path.join(dirPath, "extension.vsixmanifest");

        let vsixManifestData = await fse.readFile(vsixManifestPath, "utf8");

        const vsixmanifest = x2js.xml2js<VsixManifest>(vsixManifestData);
        const identity = vsixmanifest.PackageManifest.Metadata.Identity;

        if (this.versionNumber) { identity._Version = this.versionNumber; }
        if (this.id) { identity._Id = this.id; }
        if (this.idTag) { identity._Id += this.idTag; }
        if (this.publisher) { identity._Publisher = this.publisher; }
        if (this.extensionName) { vsixmanifest.PackageManifest.Metadata.DisplayName = this.extensionName; }
        if (this.extensionVisibility && this.extensionVisibility !== "default") {
            const flagsEditor = new GalleryFlagsEditor(vsixmanifest.PackageManifest.Metadata.GalleryFlags);

            const isPublic = this.extensionVisibility.indexOf("public") >= 0;
            const isPreview = this.extensionVisibility.indexOf("preview") >= 0;

            if (isPublic) {
                flagsEditor.addPublicFlag();
            }
            else {
                flagsEditor.removePublicFlag();
            }

            if (isPreview) {
                flagsEditor.addPreviewFlag();
            }
            else {
                flagsEditor.removePreviewFlag();
            }

            vsixmanifest.PackageManifest.Metadata.GalleryFlags = flagsEditor.toString();
        }
        if (this.extensionPricing && this.extensionPricing !== "default") {
            const flagsEditor = new GalleryFlagsEditor(vsixmanifest.PackageManifest.Metadata.GalleryFlags);

            const isFree = this.extensionPricing.indexOf("free") >= 0;
            const isPaid = this.extensionPricing.indexOf("paid") >= 0;

            if (isFree) {
                flagsEditor.removePaidFlag();
            }

            if (isPaid) {
                flagsEditor.addPaidFlag();
            }

            vsixmanifest.PackageManifest.Metadata.GalleryFlags = flagsEditor.toString();
        }

        vsixManifestData = x2js.js2xml(vsixmanifest);
        const manifestData = new ManifestData(identity._Version,
            identity._Id,
            identity._Publisher,
            this.extensionVisibility,
            this.extensionPricing,
            vsixmanifest.PackageManifest.Metadata.DisplayName,
            dirPath);

        await fse.writeFile(vsixManifestPath, vsixManifestData, { encoding: "utf8" });
        return manifestData;
    }

    public hasEdits(): boolean {
        return <boolean>(this.versionNumber
            || this.id
            || this.idTag
            || this.publisher
            || this.extensionName
            || (this.extensionVisibility && this.extensionVisibility !== "default")
            || (this.extensionPricing && this.extensionPricing !== "default"))
            || this.updateTasksId;
    }

    public editVersion(version: string) {
        this.validateEditMode();
        this.versionNumber = version;
    }

    public editExtensionName(name: string) {
        this.validateEditMode();
        this.extensionName = name;
    }

    public editExtensionVisibility(visibility: string) {
        this.validateEditMode();
        this.extensionVisibility = visibility;
    }

    public editExtensionPricing(pricing: string) {
        this.validateEditMode();
        this.extensionPricing = pricing;
    }

    public editId(id: string) {
        this.validateEditMode();
        this.id = id;
    }

    public editIdTag(tag: string) {
        this.validateEditMode();
        this.idTag = tag;
    }

    public editPublisher(publisher: string) {
        this.validateEditMode();
        this.publisher = publisher;
    }

    public editUpdateTasksVersion(updateTasksVersion: boolean) {
        this.validateEditMode();
        this.updateTasksVersion = updateTasksVersion;
    }

    public editUpdateTasksId(updateTasksId: boolean) {
        this.validateEditMode();
        this.updateTasksId = updateTasksId;
    }

    private validateEditMode() {
        if (!this.edit) { throw new Error("Editing is not started"); }
    }
}
