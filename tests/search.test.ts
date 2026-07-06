import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  answerPolicy,
  answerabilityMessage,
  buildFollowupQueries,
  buildMethodBoundaryCheck,
  buildResearchContextItems,
  countTerm,
  extractQueryTerms,
  extractReasoningTechnicalQueries,
  extractTechnicalResults,
  gradeEvidence,
  inferKnowledgeBaseProfile,
  textSearch,
  type ChunkRecord,
  type DocumentRecord,
  type KnowledgeIndex,
} from '../src-ts/store.ts';

const documents: DocumentRecord[] = [
  {
    doc_id: 'doc-a',
    title: 'Matching Notes',
    authors: ['A'],
    tags: ['matching'],
    source_path: '/tmp/a.pdf',
    canonical_pdf_name: 'doc-a-aaaaaaaa.pdf',
    file_sha256: 'a'.repeat(64),
    page_count: 2,
    created_at: '2026-07-02T00:00:00.000Z',
  },
  {
    doc_id: 'doc-b',
    title: 'Transport Notes',
    authors: ['B'],
    tags: ['transport'],
    source_path: '/tmp/b.pdf',
    canonical_pdf_name: 'doc-b-bbbbbbbb.pdf',
    file_sha256: 'b'.repeat(64),
    page_count: 1,
    created_at: '2026-07-02T00:00:00.000Z',
  },
];

const chunks: ChunkRecord[] = [
  {
    chunk_id: 'doc-a:p1:c0',
    doc_id: 'doc-a',
    page: 1,
    chunk_index: 0,
    text: 'Positive assortative matching follows from a supermodular surplus function.',
  },
  {
    chunk_id: 'doc-a:p2:c0',
    doc_id: 'doc-a',
    page: 2,
    chunk_index: 1,
    text: 'Matching can be solved as an assignment problem with surplus maximization.',
  },
  {
    chunk_id: 'doc-b:p1:c0',
    doc_id: 'doc-b',
    page: 1,
    chunk_index: 0,
    text: 'Monge-Kantorovich optimal transport studies couplings and cost minimization.',
  },
];

const index: KnowledgeIndex = {
  documents,
  pages: [],
  chunks,
};

const docs = new Map(documents.map(doc => [doc.doc_id, doc]));

describe('extractQueryTerms', () => {
  it('extracts hyphenated phrases, collapsed variants, English terms, and CJK ngrams', () => {
    const analysis = extractQueryTerms('Monge-Kantorovich 是什么？最优运输');

    assert.ok(analysis.phrase_terms.includes('monge-kantorovich'));
    assert.ok(analysis.phrase_terms.includes('mongekantorovich'));
    assert.ok(analysis.key_terms.includes('monge-kantorovich'));
    assert.ok(analysis.terms.includes('什么'));
    assert.ok(analysis.terms.includes('最优'));
    assert.equal(analysis.warnings.length, 0);
  });

  it('falls back to CJK ngrams and returns a warning for Chinese-only queries', () => {
    const analysis = extractQueryTerms('最优运输');

    assert.deepEqual(analysis.key_terms, ['最优', '优运', '运输', '最优运', '优运输']);
    assert.ok(analysis.warnings.some(message => message.includes('No English or technical-symbol query terms')));
  });

  it('reports no usable terms for punctuation-only queries', () => {
    const analysis = extractQueryTerms('？？？');

    assert.deepEqual(analysis.terms, []);
    assert.ok(analysis.warnings.some(message => message.includes('No usable search terms')));
  });
});

describe('countTerm', () => {
  it('counts whole English terms without matching substrings', () => {
    assert.equal(countTerm('transport optimal transportation transport', 'transport'), 2);
  });

  it('counts hyphenated phrases case-insensitively', () => {
    assert.equal(countTerm('Monge-Kantorovich and monge-kantorovich', 'monge-kantorovich'), 2);
  });

  it('counts CJK terms as substring occurrences', () => {
    assert.equal(countTerm('最优运输和最优匹配', '最优'), 2);
  });
});

describe('textSearch', () => {
  it('ranks BM25 results by lexical evidence and returns matched terms', () => {
    const terms = extractQueryTerms('positive assortative matching supermodular').terms;
    const results = textSearch(index, docs, terms, 3, {});

    assert.equal(results[0].chunk_id, 'doc-a:p1:c0');
    assert.deepEqual(results[0].matched_terms.sort(), ['assortative', 'matching', 'positive', 'supermodular']);
    assert.ok(results[0].bm25_score > results[1].bm25_score);
  });

  it('respects document filters', () => {
    const terms = extractQueryTerms('matching surplus').terms;
    const results = textSearch(index, docs, terms, 5, { doc_id: 'doc-b' });

    assert.deepEqual(results, []);
  });
});

describe('answerability', () => {
  it('grades exact phrase evidence as direct evidence', () => {
    const query = extractQueryTerms('Monge-Kantorovich');
    const results = textSearch(index, docs, query.terms, 3, {});
    const evidence = gradeEvidence(results, query);
    const policy = answerPolicy('supported');

    assert.equal(evidence.evidence_grade, 'exact_phrase');
    assert.equal(policy.can_answer_from_kb, true);
    assert.equal(policy.must_ask_user_before_reasoning, false);
  });

  it('grades one-term matches as partial evidence when key terms are missing', () => {
    const query = extractQueryTerms('matching dimartingale');
    const results = textSearch(index, docs, query.terms, 3, {});
    const evidence = gradeEvidence(results, query);
    const policy = answerPolicy('related_only');

    assert.equal(evidence.evidence_grade, 'partial_terms');
    assert.deepEqual(evidence.missing_terms, ['dimartingale']);
    assert.equal(policy.can_answer_from_kb, false);
    assert.equal(policy.must_ask_user_before_reasoning, true);
    assert.ok(answerabilityMessage('related_only', true).includes('Do not answer from the knowledge base'));
  });

  it('does not treat a hyphenated phrase as supported when only a subterm matches', () => {
    const query = extractQueryTerms('di-martingale terminal hitting set');
    const evidence = gradeEvidence([
      {
        chunk_id: 'doc-a:p1:c0',
        doc_id: 'doc-a',
        page: 1,
        chunk_index: 0,
        text: 'A martingale is discussed here without the specialized prefix.',
        matched_terms: ['martingale'],
      },
    ], query);

    assert.equal(evidence.evidence_grade, 'partial_terms');
    assert.deepEqual(evidence.missing_terms, ['di-martingale', 'dimartingale']);
  });

  it('requires all key terms to appear in one chunk for direct support', () => {
    const query = extractQueryTerms('positive supermodular');
    const evidence = gradeEvidence([
      {
        chunk_id: 'doc-a:p1:c0',
        doc_id: 'doc-a',
        page: 1,
        chunk_index: 0,
        text: 'This chunk mentions positive evidence only.',
        matched_terms: ['positive'],
      },
      {
        chunk_id: 'doc-a:p2:c0',
        doc_id: 'doc-a',
        page: 2,
        chunk_index: 1,
        text: 'This chunk mentions supermodular evidence only.',
        matched_terms: ['supermodular'],
      },
    ], query);

    assert.equal(evidence.evidence_grade, 'partial_terms');
    assert.ok(evidence.missing_terms.length > 0);
  });
});

describe('buildResearchContextItems', () => {
  it('classifies from stored chunk text and honors includeText=false', () => {
    const localIndex: KnowledgeIndex = {
      documents: [
        {
          doc_id: 'paper-disclosure',
          title: 'Verifiable Disclosure Notes',
          authors: [],
          tags: ['paper'],
          source_path: '/tmp/paper.pdf',
          canonical_pdf_name: 'paper.pdf',
          file_sha256: 'c'.repeat(64),
          page_count: 1,
          created_at: '2026-07-02T00:00:00.000Z',
        },
      ],
      pages: [],
      chunks: [
        {
          chunk_id: 'paper-disclosure:p1:c0',
          doc_id: 'paper-disclosure',
          page: 1,
          chunk_index: 0,
          text: 'Verifiable disclosure messages restrict each sender type to a set containing the true state.',
        },
      ],
    };
    const localDocs = new Map(localIndex.documents.map(doc => [doc.doc_id, doc]));

    const context = buildResearchContextItems({
      index: localIndex,
      docs: localDocs,
      queryResults: [
        {
          query: 'disclosure message type state',
          results: [
            {
              chunk_id: 'paper-disclosure:p1:c0',
              doc_id: 'paper-disclosure',
              page: 1,
              score: 1,
              match_type: 'text',
              matched_terms: ['disclosure', 'message', 'type', 'state'],
            },
          ],
        },
      ],
      maxItems: 5,
      deduplicateBy: 'page',
      includeText: false,
      evidenceTextTokens: 100,
      includeBooks: true,
      includePapers: true,
      includeTerms: true,
    });

    assert.equal(context.items.length, 1);
    assert.equal(context.items[0].evidence_grade, 'direct_model_primitive');
    assert.equal(context.items[0].group, 'papers');
    assert.equal('evidence_text' in context.items[0], false);
    assert.equal('neighbor_context' in context.items[0], false);
  });
});

describe('extractTechnicalResults', () => {
  it('extracts technical-term headers without treating prose references as results', () => {
    const localDocuments: DocumentRecord[] = [
      {
        doc_id: 'paper-tech',
        title: 'Technical Paper',
        authors: [],
        tags: ['paper'],
        source_path: '/tmp/tech.pdf',
        canonical_pdf_name: 'tech.pdf',
        file_sha256: 'd'.repeat(64),
        page_count: 1,
        created_at: '2026-07-02T00:00:00.000Z',
      },
    ];
    const localIndex: KnowledgeIndex = {
      documents: localDocuments,
      pages: [
        {
          doc_id: 'paper-tech',
          page: 10,
          text: [
            'Lemma 2 describes the receiver best response in the next paragraph.',
            'Lemma 2. Let condition (6) be satisfied. Agent B continues if and only if pi_t is below a cutoff (21).',
            'This has two parts: (i) continuation and (ii) disclosure, unlike Example (1988).',
            'Proposition 3 (pure-strategy PBE). Let condition (6) hold. There is a unique pooling equilibrium.',
            'Definition 3 (pure-strategy\nPBE). A pure-strategy PBE consists of strategies and beliefs.',
          ].join('\n\n'),
        },
      ],
      chunks: [
        {
          chunk_id: 'paper-tech:p10:c0',
          doc_id: 'paper-tech',
          page: 10,
          chunk_index: 0,
          text: 'Lemma 2. Let condition (6) be satisfied. Agent B continues if and only if pi_t is below a cutoff.',
        },
      ],
    };

    const results = extractTechnicalResults(localIndex, new Map(localDocuments.map(doc => [doc.doc_id, doc])));

    assert.deepEqual(results.map(result => result.result_label), ['Lemma 2.', 'Proposition 3 (pure-strategy PBE).', 'Definition 3 (pure-strategy PBE).']);
    assert.equal(results[0].result_type, 'lemma');
    assert.equal(results[0].assumption_text?.includes('condition (6)'), true);
    assert.deepEqual(results[0].formula_refs, ['(6)', '(21)']);
    assert.equal(results[1].result_type, 'proposition');
    assert.equal(results[2].result_type, 'definition');
  });
});

describe('buildFollowupQueries', () => {
  it('uses evidence packet terms for iterative retrieval without repeating previous queries', () => {
    const previous = ['privacy constraint observer cannot infer sender type from public message'];
    const followups = buildFollowupQueries(
      'A dynamic disclosure game with privacy constraints.',
      previous,
      [
        {
          evidence_grade: 'direct_model_primitive',
          title: 'Bayesian privacy',
          matched_terms: ['privacy', 'message', 'type', 'observer', 'infer'],
        },
        {
          evidence_grade: 'technical_tool',
          title: 'Dynamic persuasion',
          matched_terms: ['posterior', 'martingale', 'Bayes', 'plausibility'],
        },
      ],
    );

    assert.ok(followups.length > 0);
    assert.ok(followups.some(query => query.includes('posterior') || query.includes('Bayes plausibility')));
    assert.ok(!followups.includes(previous[0]));
  });
});

describe('inferKnowledgeBaseProfile', () => {
  it('treats a concrete textbook corpus as a closed corpus boundary', () => {
    const profile = inferKnowledgeBaseProfile({
      name: 'textbook_corpus',
      sourcePath: '/examples/textbook-corpus',
      tags: ['textbook', '教材'],
      source: 'auto_inferred',
    });

    assert.equal(profile.scope_policy, 'closed_corpus');
    assert.equal(profile.method_boundary, 'corpus_internal');
    assert.equal(profile.corpus_boundary, 'knowledge_base_internal');
    assert.equal(profile.allow_method_guided_independent_reasoning, true);
    assert.equal(profile.must_label_independent_reasoning, true);
  });

  it('backfills research_corpus as an open research profile without changing corpus content', () => {
    const profile = inferKnowledgeBaseProfile({
      name: 'research_corpus',
      sourcePath: null,
      tags: [],
      source: 'default_backfill',
    });

    assert.equal(profile.scope_policy, 'open_research');
    assert.equal(profile.method_boundary, 'open_with_citations');
    assert.equal(profile.external_methods_policy, 'allowed_if_labeled');
  });
});

describe('buildMethodBoundaryCheck', () => {
  it('allows labeled method-guided reasoning when corpus methods are supported', () => {
    const profile = inferKnowledgeBaseProfile({
      name: 'textbook_corpus',
      sourcePath: '/examples/textbook-corpus',
      tags: ['textbook', '教材'],
      source: 'auto_inferred',
    });
    const check = buildMethodBoundaryCheck({
      profile,
      method_check_queries: ['derivative', 'extreme value'],
      query_results: [
        { query: 'derivative', answerability: { status: 'supported' } },
        { query: 'extreme value', answerability: { status: 'supported' } },
      ],
    });

    assert.equal(check.status, 'within_corpus_methods');
    assert.equal(check.can_answer_with_labeled_method_guided_reasoning, true);
    assert.deepEqual(check.unsupported_queries, []);
  });

  it('allows labeled method-guided reasoning from partial hits on core method terms', () => {
    const profile = inferKnowledgeBaseProfile({
      name: 'textbook_corpus',
      sourcePath: '/examples/textbook-corpus',
      tags: ['textbook', '教材'],
      source: 'auto_inferred',
    });
    const check = buildMethodBoundaryCheck({
      profile,
      method_check_queries: [
        'average rate of change f(x2)-f(x1) divided by x2-x1',
        'derivative defined as limit of difference quotient',
      ],
      min_supported_queries: 2,
      query_results: [
        {
          query: 'average rate of change f(x2)-f(x1) divided by x2-x1',
          answerability: {
            status: 'related_only',
            evidence_grade: 'partial_terms',
            matched_terms: ['average', 'rate', 'change'],
          },
          partial_results: [{ citation: 'Textbook Example, p. 8' }],
        },
        {
          query: 'derivative defined as limit of difference quotient',
          answerability: {
            status: 'related_only',
            evidence_grade: 'partial_terms',
            matched_terms: ['derivative'],
          },
          partial_results: [{ citation: 'Textbook Example, p. 14' }],
        },
      ],
    });

    assert.equal(check.status, 'within_corpus_methods');
    assert.equal(check.can_answer_with_labeled_method_guided_reasoning, true);
    assert.deepEqual(check.supported_queries, [
      'average rate of change f(x2)-f(x1) divided by x2-x1',
      'derivative defined as limit of difference quotient',
    ]);
    assert.equal(check.method_evidence?.[0].support_level, 'method_term_evidence');
  });

  it('does not treat generic partial hits as method support', () => {
    const profile = inferKnowledgeBaseProfile({
      name: 'textbook_corpus',
      sourcePath: '/examples/textbook-corpus',
      tags: ['textbook', '教材'],
      source: 'auto_inferred',
    });
    const check = buildMethodBoundaryCheck({
      profile,
      method_check_queries: ['function value line textbook'],
      query_results: [
        {
          query: 'function value line textbook',
          answerability: {
            status: 'related_only',
            evidence_grade: 'partial_terms',
            matched_terms: ['function', 'value', 'line'],
          },
        },
      ],
    });

    assert.equal(check.status, 'not_supported');
    assert.equal(check.can_answer_with_labeled_method_guided_reasoning, false);
  });

  it('does not allow method-guided reasoning when required method queries are missing', () => {
    const profile = inferKnowledgeBaseProfile({
      name: 'textbook_corpus',
      sourcePath: '/examples/textbook-corpus',
      tags: ['textbook', '教材'],
      source: 'auto_inferred',
    });
    const check = buildMethodBoundaryCheck({
      profile,
      method_check_queries: ['derivative', 'exponential tangent inequality'],
      query_results: [
        { query: 'derivative', answerability: { status: 'supported' } },
        { query: 'exponential tangent inequality', answerability: { status: 'related_only' } },
      ],
    });

    assert.equal(check.status, 'partial_method_support');
    assert.equal(check.can_answer_with_labeled_method_guided_reasoning, false);
    assert.deepEqual(check.unsupported_queries, ['exponential tangent inequality']);
  });
});

describe('extractReasoningTechnicalQueries', () => {
  it('filters topic terms while keeping non-topic technical methods', () => {
    const queries = extractReasoningTechnicalQueries({
      problem: '一个 k-阶弦平衡函数可能是一个一元二次函数吗？',
      answer: '可以先用洛必达法则处理极限，也可以用导数差商说明。',
      topic_terms: ['二次函数'],
    });

    assert.ok(queries.some(query => query.includes('洛必达')));
    assert.ok(queries.some(query => query.includes('导数')));
    assert.ok(!queries.some(query => query.includes('二次函数')));
    assert.ok(!queries.some(query => query === 'quadratic'));
  });

  it('uses supplied technical queries verbatim when the agent provides them', () => {
    const queries = extractReasoningTechnicalQueries({
      problem: 'quadratic function problem',
      answer: 'Use Taylor expansion.',
      technical_queries: ['Taylor expansion theorem', 'LHopital rule'],
    });

    assert.deepEqual(queries, ['Taylor expansion theorem', 'LHopital rule']);
  });
});
