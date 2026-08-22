/**
 * Export job queue.
 *
 * In-process and dependency-free rather than BullMQ on Redis. An export is a
 * single bounded task measured in seconds, and requiring people to stand up
 * Redis before they can convert one site would be the wrong trade. The
 * interface is deliberately shaped so a durable backend can replace the store
 * without touching callers.
 *
 * Concurrency is capped because each job already runs its own bounded fetch
 * pool; letting several exports run at once would multiply out and trip the
 * CDN throttling that phase 03 exists to avoid.
 */

import { randomUUID } from 'node:crypto';
import type { AssetMode } from './types.js';
import type { SiteReport } from './site.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface JobOptions {
  url: string;
  assetMode: AssetMode;
  baseUrl?: string;
  maxPages: number;
  compileAnimations: boolean;
  /** Keep Framer's runtime so animations and components behave as published. */
  keepRuntime?: boolean;
  /**
   * Write a preview server into the export.
   *
   * Without it, someone who unzips the folder and opens index.html sees the
   * page with no JavaScript at all, because browsers block ES modules over
   * file://. That reads as a broken export.
   */
  includePreview?: boolean;
}

export interface JobProgress {
  at: number;
  message: string;
}

export interface Job {
  id: string;
  options: JobOptions;
  status: JobStatus;
  progress: JobProgress[];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  report?: SiteReport;
  /** Path to the packaged ZIP, once the job succeeds. */
  zipPath?: string;
  zipBytes?: number;
  error?: string;
}

/** Public view of a job — never exposes filesystem paths to a client. */
export interface JobView {
  id: string;
  status: JobStatus;
  url: string;
  progress: JobProgress[];
  createdAt: number;
  finishedAt?: number;
  error?: string;
  downloadUrl?: string;
  zipBytes?: number;
  /** Which pipeline produced this job, for the UI to label it. */
  mode?: 'clean' | 'full';
  summary?: {
    pagesExported: number;
    pagesFailed: number;
    uniqueAssets: number;
    assetsDownloaded: number;
    totalAnimationRules: number;
    totalArtifactsRemoved: number;
    warnings: string[];
  };
}

export type JobRunner = (
  job: Job,
  onProgress: (message: string) => void,
) => Promise<{ report: SiteReport; zipPath: string; zipBytes: number }>;

type Listener = (job: Job) => void;

export class ExportQueue {
  private readonly jobs = new Map<string, Job>();
  private readonly waiting: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();
  private active = 0;

  constructor(
    private readonly runner: JobRunner,
    private readonly concurrency = 1,
  ) {}

  enqueue(options: JobOptions): Job {
    const job: Job = {
      id: randomUUID(),
      options,
      status: 'queued',
      progress: [],
      createdAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.waiting.push(job.id);
    queueMicrotask(() => this.pump());
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Subscribe to updates for one job. Returns an unsubscribe function. */
  subscribe(id: string, listener: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(id);
    };
  }

  private emit(job: Job): void {
    for (const listener of this.listeners.get(job.id) ?? []) {
      // A throwing listener must not take down the job.
      try {
        listener(job);
      } catch {
        /* ignore */
      }
    }
  }

  private pump(): void {
    while (this.active < this.concurrency && this.waiting.length > 0) {
      const id = this.waiting.shift()!;
      const job = this.jobs.get(id);
      if (!job) continue;
      void this.run(job);
    }
  }

  private async run(job: Job): Promise<void> {
    this.active++;
    job.status = 'running';
    job.startedAt = Date.now();
    this.emit(job);

    const onProgress = (message: string) => {
      job.progress.push({ at: Date.now(), message });
      this.emit(job);
    };

    try {
      const { report, zipPath, zipBytes } = await this.runner(job, onProgress);
      job.report = report;
      job.zipPath = zipPath;
      job.zipBytes = zipBytes;
      job.status = 'done';
    } catch (err) {
      job.error = err instanceof Error ? err.message : String(err);
      job.status = 'failed';
    } finally {
      job.finishedAt = Date.now();
      this.active--;
      this.emit(job);
      this.pump();
    }
  }
}

/** Convert a job to its public representation. */
export function toJobView(job: Job): JobView {
  return {
    id: job.id,
    status: job.status,
    url: job.options.url,
    progress: job.progress,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    error: job.error,
    downloadUrl: job.status === 'done' ? `/api/jobs/${job.id}/download` : undefined,
    zipBytes: job.zipBytes,
    mode: job.options.keepRuntime ? 'full' : 'clean',
    summary: job.report
      ? {
          pagesExported: job.report.pagesExported,
          pagesFailed: job.report.pagesFailed,
          uniqueAssets: job.report.uniqueAssets,
          assetsDownloaded: job.report.assetsDownloaded,
          totalAnimationRules: job.report.totalAnimationRules,
          totalArtifactsRemoved: job.report.totalArtifactsRemoved,
          warnings: job.report.warnings,
        }
      : undefined,
  };
}
