"""Offline retrieval/sidecar protocol tests. All encoder/network calls mocked."""

from __future__ import annotations

import io
import json
import os
import sqlite3
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch

from server import retrieval as rag
from services.embeddings import app as embeddings


class MockEncoderClient:
    def __init__(self, dimension=2, fingerprint="1" * 64, *, reranker=False):
        self.dimension = dimension
        self.fingerprint = fingerprint
        self.calls = []
        self.reranker = reranker

    def health(self):
        return {"ready": True, "model": "offline-test-encoder", "modelFingerprint": self.fingerprint,
                "dimension": self.dimension, "rerankerReady": self.reranker}

    def embed(self, texts, model):
        self.calls.append(list(texts))
        result = []
        for text in texts:
            semantic = any(word in text.lower() for word in ("doctor", "clinician", "physician", "patients", "medicine"))
            vector = [1.0, 0.0] if semantic else [0.0, 1.0]
            result.append(vector + [0.0] * (self.dimension - 2))
        return result

    def rerank(self, query, texts, model):
        return list(range(len(texts)))


class HybridRetrievalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.cache = Path(self.temporary.name) / "semantic.sqlite3"
        self.namespace = "exam:exam-20251008-012345abcdef:revision-1"
        self.documents = [
            {"id": "official-q1", "text": "Official answer: B", "questionId": "q1", "examId": "exam1", "revision": "revision-1"},
            {"id": "doctor", "text": "The doctor helps patients", "questionId": "q2", "examId": "exam1", "revision": "revision-1"},
            {"id": "weather", "text": "Clouds bring rain", "questionId": "q3", "examId": "exam1", "revision": "revision-1"},
        ]

    def tearDown(self):
        self.temporary.cleanup()

    def test_default_is_honest_lexical_and_zero_network(self):
        with patch.object(rag.LocalEmbeddingClient, "health", side_effect=AssertionError("network forbidden")), \
             patch.object(rag, "build_opener", side_effect=AssertionError("network forbidden")):
            retriever = rag.HybridRetriever(cache_path=self.cache)
            result = retriever.rank("doctor", self.documents, namespace=self.namespace)
        self.assertEqual(result["mode"], "lexical_hash")
        self.assertFalse(result["status"]["semanticReady"])
        self.assertEqual(result["documents"][0]["id"], "doctor")
        self.assertFalse(self.cache.exists())

    def test_no_lexical_overlap_is_not_a_hash_or_random_hit(self):
        result = rag.HybridRetriever(cache_path=self.cache).rank("unrelated mathematics", self.documents, namespace=self.namespace)
        self.assertEqual(result["documents"], [])

    def test_semantic_paraphrase_can_retrieve_without_shared_tokens(self):
        client = MockEncoderClient()
        result = rag.HybridRetriever(client, self.cache).rank("clinician treats ill people", self.documents, namespace=self.namespace)
        self.assertEqual(result["mode"], "hybrid_semantic")
        self.assertEqual([document["id"] for document in result["documents"]], ["doctor"])
        self.assertIn("dense_local", result["documents"][0]["retrievalSources"])
        self.assertEqual(result["status"]["indexedDocuments"], 3)

    def test_exact_question_ids_precede_semantic_supplement(self):
        result = rag.HybridRetriever(MockEncoderClient(), self.cache).rank("clinician", self.documents, namespace=self.namespace, exact_ids=["official-q1"], top_k=2)
        self.assertEqual([document["id"] for document in result["documents"]], ["official-q1", "doctor"])
        self.assertTrue(result["documents"][0]["exact"])
        self.assertEqual(result["documents"][0]["score"], 1.0)

    def test_metadata_filter_excludes_other_exam_and_revision_before_embedding(self):
        client = MockEncoderClient()
        other = [{**self.documents[1], "id": "secret-other-exam", "examId": "exam2"},
                 {**self.documents[1], "id": "secret-old-revision", "revision": "revision-0"}]
        result = rag.HybridRetriever(client, self.cache).rank("doctor", self.documents + other, namespace=self.namespace,
                  required_metadata={"examId": "exam1", "revision": "revision-1"}, exact_ids=["secret-other-exam"])
        self.assertEqual([document["id"] for document in result["documents"]], ["doctor"])
        self.assertEqual(result["status"]["corpusDocuments"], 3)
        self.assertEqual(sum(len(batch) for batch in client.calls), 4)

    def test_cache_reuses_documents_but_never_query_vectors(self):
        client = MockEncoderClient()
        retriever = rag.HybridRetriever(client, self.cache)
        retriever.rank("doctor", self.documents, namespace=self.namespace)
        client.calls.clear()
        retriever.rank("clinician", self.documents, namespace=self.namespace)
        self.assertEqual(client.calls, [["clinician"]])
        with sqlite3.connect(self.cache) as connection:
            dump = " ".join(str(row) for row in connection.execute("SELECT * FROM vectors"))
        self.assertNotIn("patients", dump)
        self.assertNotIn("official-q1", dump)
        self.assertNotIn(self.namespace, dump)

    def test_namespace_revision_change_reindexes_without_cross_exam_reuse(self):
        client = MockEncoderClient()
        retriever = rag.HybridRetriever(client, self.cache)
        retriever.rank("doctor", self.documents, namespace=self.namespace)
        client.calls.clear()
        retriever.rank("doctor", self.documents, namespace=self.namespace + "-next")
        self.assertEqual(sum(len(batch) for batch in client.calls), 4)

    def test_changed_text_model_and_dimension_never_reuse_stale_vectors(self):
        first = rag.HybridRetriever(MockEncoderClient(), self.cache)
        first.rank("doctor", self.documents, namespace=self.namespace)
        changed = [{**document, "text": document["text"] + " revised"} if document["id"] == "doctor" else document for document in self.documents]
        second_client = MockEncoderClient()
        rag.HybridRetriever(second_client, self.cache).rank("doctor", changed, namespace=self.namespace)
        self.assertEqual(sum(len(batch) for batch in second_client.calls), 2)
        for dimension, fingerprint in ((2, "2" * 64), (3, "2" * 64)):
            client = MockEncoderClient(dimension, fingerprint)
            result = rag.HybridRetriever(client, self.cache).rank("doctor", self.documents, namespace=self.namespace)
            self.assertEqual(sum(len(batch) for batch in client.calls), 4)
            self.assertTrue(result["status"]["semanticReady"])

    def test_corrupt_cache_file_is_not_overwritten(self):
        self.cache.write_bytes(b"damaged cache preserve these bytes")
        before = self.cache.read_bytes()
        result = rag.HybridRetriever(MockEncoderClient(), self.cache).rank("doctor", self.documents, namespace=self.namespace)
        self.assertEqual(self.cache.read_bytes(), before)
        self.assertEqual(result["status"]["cacheStatus"], "unavailable_preserved")
        self.assertEqual(result["documents"][0]["id"], "doctor")

    def test_corrupt_cached_vector_is_preserved_without_replace(self):
        retriever = rag.HybridRetriever(MockEncoderClient(), self.cache)
        retriever.rank("doctor", self.documents, namespace=self.namespace)
        with sqlite3.connect(self.cache) as connection:
            connection.execute("UPDATE vectors SET vector='[\"broken\"]'")
        result = retriever.rank("doctor", self.documents, namespace=self.namespace)
        self.assertEqual(result["status"]["cacheStatus"], "unavailable_preserved")
        with sqlite3.connect(self.cache) as connection:
            self.assertEqual(set(row[0] for row in connection.execute("SELECT vector FROM vectors")), {'["broken"]'})

    def test_authorized_private_notes_are_not_persisted(self):
        result = rag.HybridRetriever(MockEncoderClient(), self.cache).rank("doctor", self.documents, namespace=self.namespace, persist=False)
        self.assertTrue(result["status"]["semanticReady"])
        self.assertEqual(result["status"]["cacheStatus"], "disabled_for_private_context")
        self.assertFalse(self.cache.exists())

    def test_embedding_failures_fall_back_to_lexical_not_false_semantic(self):
        client = MockEncoderClient()
        client.embed = Mock(side_effect=rag.RetrievalError("mock timeout"))
        result = rag.HybridRetriever(client, self.cache).rank("doctor", self.documents, namespace=self.namespace)
        self.assertEqual(result["mode"], "lexical_hash")
        self.assertFalse(result["status"]["semanticReady"])
        self.assertEqual(result["documents"][0]["id"], "doctor")
        self.assertNotIn("dense_local", result["documents"][0]["retrievalSources"])

    def test_reranker_never_displaces_exact_question_binding(self):
        client = MockEncoderClient(reranker=True)
        result = rag.HybridRetriever(client, self.cache).rank("doctor clouds", self.documents, namespace=self.namespace, exact_ids=["official-q1"])
        self.assertEqual(result["documents"][0]["id"], "official-q1")
        self.assertTrue(result["status"]["rerankerUsed"])

    def test_partial_semantic_coverage_is_explicit_and_bounded(self):
        documents = [{"id": f"d{index:04d}", "text": "doctor"} for index in range(140)]
        result = rag.HybridRetriever(MockEncoderClient(), self.cache).rank("clinician", documents, namespace=self.namespace)
        self.assertEqual(result["mode"], "hybrid_semantic_partial")
        self.assertEqual(result["status"]["indexedDocuments"], 128)
        self.assertEqual(result["status"]["corpusDocuments"], 140)

    def test_rrf_rewards_overlap_and_deduplicates_rankings(self):
        scores = rag.reciprocal_rank_fusion([["a", "a", "b"], ["b", "c"]])
        self.assertGreater(scores["b"], scores["a"])
        self.assertAlmostEqual(scores["a"], 1 / 61)

    def test_boundaries_and_unpinned_namespace_rejected(self):
        retriever = rag.HybridRetriever(cache_path=self.cache)
        for values in ({"namespace": "exam:unversioned"}, {"namespace": self.namespace, "top_k": 0},
                       {"namespace": self.namespace, "top_k": True}):
            with self.subTest(values=values), self.assertRaises(rag.RetrievalError):
                retriever.rank("doctor", self.documents, **values)
        with self.assertRaises(rag.RetrievalError):
            retriever.rank("doctor", [self.documents[0], self.documents[0]], namespace=self.namespace)
        with self.assertRaises(rag.RetrievalError):
            retriever.rank("x" * (rag.MAX_QUERY_CHARS + 1), [], namespace=self.namespace)


class LocalProtocolTests(unittest.TestCase):
    def test_remote_urls_credentials_redirect_targets_rejected_without_open(self):
        addresses = ["https://127.0.0.1:8780", "http://example.com:8780", "http://localhost:8780",
                     "http://127.0.0.2:8780", "http://127.0.0.1:8780/path", "http://127.0.0.1:8780?url=evil",
                     "http://user:secret@127.0.0.1:8780", "http://127.0.0.1:80"]
        with patch.object(rag, "build_opener", side_effect=AssertionError("no network creation")):
            for address in addresses:
                with self.subTest(address=address), self.assertRaises(rag.RetrievalError):
                    rag.LocalEmbeddingClient(address)
        with self.assertRaises(rag.RetrievalError):
            rag._NoRedirects().redirect_request(None, None, 302, "", {}, "https://example.com")

    def test_bad_configuration_reports_not_ready_and_zero_network(self):
        with patch.dict(os.environ, {"CET_EMBEDDING_URL": "https://external.example/embed", "CET_EMBEDDING_TOKEN": ""}), \
             patch.object(rag, "build_opener", side_effect=AssertionError("no network creation")):
            status = rag.get_retriever().status()
        self.assertFalse(status["configured"])
        self.assertEqual(status["reason"], "invalid_loopback_configuration")

    def test_health_and_embed_verify_actual_model_dimension_and_numeric_vectors(self):
        client = rag.LocalEmbeddingClient("http://127.0.0.1:8780")
        health = {"schemaVersion": 1, "ready": True, "model": "test", "modelFingerprint": "1" * 64, "dimension": 2}
        with patch.object(client, "_request", return_value=health):
            model = client.health()
        valid = {"modelFingerprint": "1" * 64, "dimension": 2, "vectors": [[3, 4]]}
        with patch.object(client, "_request", return_value=valid):
            self.assertEqual(client.embed(["text"], model), [[0.6, 0.8]])
        invalids = [{**valid, "modelFingerprint": "2" * 64}, {**valid, "dimension": 3},
                    {**valid, "vectors": [[0, 0]]}, {**valid, "vectors": [[float("nan"), 1]]},
                    {**valid, "vectors": [[True, 1]]}, {**valid, "vectors": [[1]]}]
        for invalid in invalids:
            with self.subTest(invalid=invalid), patch.object(client, "_request", return_value=invalid), self.assertRaises(rag.RetrievalError):
                client.embed(["text"], model)

    def test_sidecar_remains_stdlib_import_and_missing_model_does_not_download(self):
        models = embeddings.LocalModels("")
        with patch.dict(sys.modules, {"sentence_transformers": None}), patch.object(embeddings, "local_model_directory", side_effect=AssertionError("no artifact lookup")):
            models.load()
        self.assertFalse(models.health()["ready"])
        self.assertFalse(models.health()["automaticDownloads"])

    def test_only_local_safe_artifacts_and_builtin_modules_accepted(self):
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "config.json").write_text("{}")
            (directory / "model.safetensors").write_bytes(b"mock local weights")
            self.assertEqual(embeddings.local_model_directory(str(directory)), directory)
            for invalid in ("BAAI/bge-m3", "https://example.com/model", str(directory / "missing")):
                with self.assertRaises(embeddings.RequestError):
                    embeddings.local_model_directory(invalid)
            (directory / "modules.json").write_text(json.dumps([{"type": "untrusted.CustomModel", "path": ""}]))
            with self.assertRaises(embeddings.RequestError):
                embeddings.local_model_directory(str(directory))
            (directory / "modules.json").write_text(json.dumps([{"type": "sentence_transformers.models.Pooling", "path": "../escape"}]))
            with self.assertRaises(embeddings.RequestError):
                embeddings.local_model_directory(str(directory))

    def test_safe_artifact_content_changes_fingerprint(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary)
            (path / "config.json").write_text("{}")
            weights = path / "model.safetensors"
            weights.write_bytes(b"first")
            before = embeddings.model_fingerprint(path)
            weights.write_bytes(b"later")
            self.assertNotEqual(before, embeddings.model_fingerprint(path))

    def test_lazy_encoder_loading_uses_offline_local_only_and_no_custom_code(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary)
            (path / "config.json").write_text("{}")
            (path / "model.safetensors").write_bytes(b"offline mock")
            encoder = Mock(max_seq_length=1024)
            encoder.get_sentence_embedding_dimension.return_value = 2
            constructor = Mock(return_value=encoder)
            with patch.dict(sys.modules, {"sentence_transformers": SimpleNamespace(SentenceTransformer=constructor)}), patch.dict(os.environ, {}):
                models = embeddings.LocalModels(str(path))
                models.load()
                self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
                self.assertEqual(os.environ["TRANSFORMERS_OFFLINE"], "1")
            constructor.assert_called_once_with(str(path), device="cpu", local_files_only=True, trust_remote_code=False, model_kwargs={"use_safetensors": True})
            self.assertTrue(models.health()["ready"])
            self.assertEqual(encoder.max_seq_length, 512)

    def test_sidecar_request_bounds_fingerprint_and_vectors(self):
        models = embeddings.LocalModels("")
        models.encoder = Mock()
        models.encoder.encode.return_value = [[3.0, 4.0]]
        models.dimension = 2
        models.fingerprint = "1" * 64
        payload = {"texts": ["safe original sentence"], "modelFingerprint": models.fingerprint}
        result = models.execute("/v1/embed", payload)
        self.assertEqual(result["vectors"], [[0.6, 0.8]])
        for bad in ({**payload, "model": "external"}, {**payload, "modelFingerprint": "2" * 64},
                    {**payload, "texts": ["x" * 4001]}, {**payload, "texts": ["x"] * 129},
                    {**payload, "texts": ["secret\x00"]}):
            with self.subTest(bad=bad), self.assertRaises(embeddings.RequestError):
                models.execute("/v1/embed", bad)

    def test_sidecar_handler_blocks_browser_origins_and_checks_token(self):
        handler = object.__new__(embeddings.EmbeddingHandler)
        handler.client_address = ("127.0.0.1", 1234)
        handler.server = SimpleNamespace(token="test-local-token")
        handler._json = Mock()
        handler.headers = {"Origin": "http://127.0.0.1:4173", "Authorization": "Bearer test-local-token"}
        self.assertFalse(handler._authorized())
        handler.headers = {}
        self.assertFalse(handler._authorized())
        handler.headers = {"Authorization": "Bearer test-local-token"}
        self.assertTrue(handler._authorized())


if __name__ == "__main__":
    unittest.main()
