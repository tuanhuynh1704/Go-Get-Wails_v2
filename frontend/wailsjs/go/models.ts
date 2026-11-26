export namespace dto {
	
	export class AddError {
	    url: string;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new AddError(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.url = source["url"];
	        this.error = source["error"];
	    }
	}
	export class AddRequest {
	    urls: string[];
	    saveDir: string;
	    segments: number;
	
	    static createFrom(source: any = {}) {
	        return new AddRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.urls = source["urls"];
	        this.saveDir = source["saveDir"];
	        this.segments = source["segments"];
	    }
	}
	export class AddResult {
	    ids: string[];
	    errors: AddError[];
	
	    static createFrom(source: any = {}) {
	        return new AddResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ids = source["ids"];
	        this.errors = this.convertValues(source["errors"], AddError);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SegmentDTO {
	    index: number;
	    start: number;
	    end: number;
	    done: number;
	    status: string;
	
	    static createFrom(source: any = {}) {
	        return new SegmentDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.index = source["index"];
	        this.start = source["start"];
	        this.end = source["end"];
	        this.done = source["done"];
	        this.status = source["status"];
	    }
	}
	export class Settings {
	    downloadDir: string;
	    maxConcurrentFiles: number;
	    segmentsPerFile: number;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.downloadDir = source["downloadDir"];
	        this.maxConcurrentFiles = source["maxConcurrentFiles"];
	        this.segmentsPerFile = source["segmentsPerFile"];
	    }
	}
	export class Stats {
	    globalSpeed: number;
	    active: number;
	    queued: number;
	
	    static createFrom(source: any = {}) {
	        return new Stats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.globalSpeed = source["globalSpeed"];
	        this.active = source["active"];
	        this.queued = source["queued"];
	    }
	}
	export class TaskDTO {
	    id: string;
	    url: string;
	    fileName: string;
	    category: string;
	    saveDir: string;
	    status: string;
	    error?: string;
	    total: number;
	    done: number;
	    speed: number;
	    etaSec: number;
	    segCount: number;
	    resumable: boolean;
	    segs: number[];
	    createdAt: number;
	
	    static createFrom(source: any = {}) {
	        return new TaskDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.url = source["url"];
	        this.fileName = source["fileName"];
	        this.category = source["category"];
	        this.saveDir = source["saveDir"];
	        this.status = source["status"];
	        this.error = source["error"];
	        this.total = source["total"];
	        this.done = source["done"];
	        this.speed = source["speed"];
	        this.etaSec = source["etaSec"];
	        this.segCount = source["segCount"];
	        this.resumable = source["resumable"];
	        this.segs = source["segs"];
	        this.createdAt = source["createdAt"];
	    }
	}
	export class Snapshot {
	    tasks: TaskDTO[];
	    stats: Stats;
	
	    static createFrom(source: any = {}) {
	        return new Snapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.tasks = this.convertValues(source["tasks"], TaskDTO);
	        this.stats = this.convertValues(source["stats"], Stats);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	export class TaskDetail {
	    task: TaskDTO;
	    segments: SegmentDTO[];
	
	    static createFrom(source: any = {}) {
	        return new TaskDetail(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.task = this.convertValues(source["task"], TaskDTO);
	        this.segments = this.convertValues(source["segments"], SegmentDTO);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

