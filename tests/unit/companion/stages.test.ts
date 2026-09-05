import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { FindSimilarOutput, ResearchBrief, ResearchSource } from '../../../src/types.js';

/**
 * The corpus + brief injected broker stages (`wigolo/companion-stages`). The SERP's `search` stage is
 * the sibling `stages-search.test.ts`, split off because it mocks a different handler and asserts the
 * no-database claim against the REAL `cache/db` module.
 *
 * What is worth pinning here is the ADAPTATION, not the pipelines underneath — those have their own
 * suites. Three things can silently break the rail and none of them is visible from the pipeline side:
 * the argument vector the brief adapter pins (a pipeline argument added in the middle would shift the
 * caps onto the wrong parameters and the brief would still be a brief), whether a refusal throws or
 * degrades to something the app reads as an empty corpus, and whether the embedding init the factory
 * owns runs once or once per call.
 */
const handleFindSimilar = vi.fn();
const buildResearchBrief = vi.fn();
const embeddingInit = vi.fn();

vi.mock('../../../src/tools/find-similar.js', () => ({
  handleFindSimilar: (...args: unknown[]) => handleFindSimilar(...args),
}));
vi.mock('../../../src/research/brief.js', () => ({
  buildResearchBrief: (...args: unknown[]) => buildResearchBrief(...args),
}));
vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => ({ init: () => embeddingInit() }),
}));

const { createBriefStage, createFindSimilarStage, FindSimilarStageError } = await import(
  '../../../src/companion/stages.js'
);

const OUTPUT = { results: [], response_time_ms: 1 } as unknown as FindSimilarOutput;

beforeEach(() => {
  handleFindSimilar.mockReset();
  buildResearchBrief.mockReset();
  embeddingInit.mockReset();
  embeddingInit.mockResolvedValue(undefined);
});

describe('createFindSimilarStage', () => {
  it('answers with the handler payload unwrapped, not the StageResult envelope', async () => {
    handleFindSimilar.mockResolvedValue({ ok: true, data: OUTPUT });

    const stage = createFindSimilarStage();

    // The app reads `out.results`; an envelope would make every hit invisible while the call succeeds.
    await expect(stage({ concept: 'sqlite wal' })).resolves.toBe(OUTPUT);
  });

  it('binds core-built engines, a router and a backend status to every call', async () => {
    handleFindSimilar.mockResolvedValue({ ok: true, data: OUTPUT });

    await createFindSimilarStage()({ concept: 'sqlite wal' });

    const [input, engines, router, backendStatus] = handleFindSimilar.mock.calls[0] as [
      unknown,
      unknown[],
      unknown,
      unknown,
    ];
    expect(input).toEqual({ concept: 'sqlite wal' });
    // Two built-in engines is core's own construction; an empty array would be a stage that
    // silently cannot fall back, and `undefined` collaborators would throw deep inside the pipeline.
    expect(engines).toHaveLength(2);
    expect(router).toBeDefined();
    expect(backendStatus).toBeDefined();
  });

  it('throws a typed refusal carrying the handler code rather than answering an empty corpus', async () => {
    handleFindSimilar.mockResolvedValue({
      ok: false,
      error: 'invalid_url',
      error_reason: 'private address',
      stage: 'find_similar',
    });

    const stage = createFindSimilarStage();
    const err = await stage({ url: 'http://127.0.0.1/' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FindSimilarStageError);
    expect((err as InstanceType<typeof FindSimilarStageError>).code).toBe('invalid_url');
    expect((err as Error).message).toBe('private address');
  });

  it('initialises the embedding service once per factory, not once per call', async () => {
    handleFindSimilar.mockResolvedValue({ ok: true, data: OUTPUT });

    const stage = createFindSimilarStage();
    await stage({ concept: 'a' });
    await stage({ concept: 'b' });

    // The init provisions the vector store and runs the legacy migration; per-call would pay it on
    // every keystroke the rail answers.
    expect(embeddingInit).toHaveBeenCalledTimes(1);
  });

  it('still answers when the embedding init fails — the FTS5 lane is the degraded floor', async () => {
    embeddingInit.mockRejectedValue(new Error('sqlite-vec unavailable'));
    handleFindSimilar.mockResolvedValue({ ok: true, data: OUTPUT });

    await expect(createFindSimilarStage()({ concept: 'a' })).resolves.toBe(OUTPUT);
  });

  it('skips the embedding init when the caller already ran initSubsystems in-process', async () => {
    handleFindSimilar.mockResolvedValue({ ok: true, data: OUTPUT });

    await createFindSimilarStage({ skipEmbeddingInit: true })({ concept: 'a' });

    expect(embeddingInit).not.toHaveBeenCalled();
  });
});

describe('createBriefStage', () => {
  it('maps the broker four-argument stage onto the pipeline arity with the caps in position', async () => {
    const brief = { topics: [] } as unknown as ResearchBrief;
    buildResearchBrief.mockResolvedValue(brief);
    const sources: ResearchSource[] = [];

    await expect(createBriefStage()('Session summary', sources, 3000, 40_000)).resolves.toBe(brief);

    // Positional, deliberately: the caps sit at index 3 and 4 ONLY because `subQueries` occupies 2.
    // Asserting the whole vector is what makes a pipeline argument inserted before them go red here
    // instead of quietly shaping a brief against the wrong budget.
    expect(buildResearchBrief).toHaveBeenCalledWith(
      'Session summary',
      sources,
      [],
      3000,
      40_000,
      'general',
      [],
    );
  });

  it('never asks for a comparison shaping — session synthesis has no entities to compare', async () => {
    buildResearchBrief.mockResolvedValue({} as ResearchBrief);

    await createBriefStage()('q', [], 10, 20);

    const [, , subQueries, , , queryType, comparisonEntities] = buildResearchBrief.mock.calls[0]!;
    expect(subQueries).toEqual([]);
    expect(queryType).toBe('general');
    expect(comparisonEntities).toEqual([]);
  });
});
