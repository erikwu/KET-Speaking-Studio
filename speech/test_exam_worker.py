import contextlib
import importlib
import io
import json
import os
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

from speech import exam_worker


class ExamWorkerTests(unittest.TestCase):
    def test_runtimeCheckReportsMissingPackagesAndFfmpeg(self):
        with patch.object(exam_worker.importlib.util, "find_spec", side_effect=lambda name: None if name == "mlx_lm" else object()), patch.object(exam_worker.shutil, "which", return_value=None):
            self.assertEqual(exam_worker.runtime_status("ffmpeg"), {
                "asrPackageReady": True, "scoringPackageReady": False, "ffmpegReady": False,
            })

    def test_transcribe_usesEnglishAndLocalModelPath(self):
        mock_module = types.SimpleNamespace(transcribe=Mock(return_value={"text": "  I like music.  "}))
        with tempfile.NamedTemporaryFile() as audio, patch.dict(sys.modules, {"mlx_whisper": mock_module}):
            worker = exam_worker.ExamWorker("/local/asr", "/local/scoring")
            self.assertEqual(worker.transcribe(audio.name), {"transcript": "I like music."})
        mock_module.transcribe.assert_called_once_with(audio.name, path_or_hf_repo="/local/asr", language="en", task="transcribe")

    def test_loadsEachModelOnlyOnce(self):
        tokenizer = types.SimpleNamespace(apply_chat_template=Mock(return_value="prompt"))
        model_module = types.SimpleNamespace(load=Mock(return_value=(object(), tokenizer)), generate=Mock(return_value='{"relevance":{"score":4,"feedback":"切题"},"completeness":{"score":4,"feedback":"完整"},"grammar":{"score":4,"feedback":"正确"},"vocabulary":{"score":4,"feedback":"准确"}}'))
        sample_utils = types.SimpleNamespace(make_sampler=lambda **kwargs: kwargs)
        with patch.dict(sys.modules, {"mlx_lm": model_module, "mlx_lm.sample_utils": sample_utils}):
            worker = exam_worker.ExamWorker("/local/asr", "/local/scoring")
            worker.score("question", "reference", "answer")
            worker.score("question", "reference", "answer")
        model_module.load.assert_called_once_with("/local/scoring")

    def test_score_returnsFourDimensionsWithoutTotal(self):
        tokenizer = types.SimpleNamespace(apply_chat_template=Mock(return_value="prompt"))
        output = '{"relevance":{"score":4,"feedback":"切题"},"completeness":{"score":3,"feedback":"补细节"},"grammar":{"score":5,"feedback":"表达正确"},"vocabulary":{"score":4,"feedback":"用词准确"}}'
        model_module = types.SimpleNamespace(load=Mock(return_value=(object(), tokenizer)), generate=Mock(return_value=output))
        sample_utils = types.SimpleNamespace(make_sampler=lambda **kwargs: kwargs)
        with patch.dict(sys.modules, {"mlx_lm": model_module, "mlx_lm.sample_utils": sample_utils}):
            result = exam_worker.ExamWorker("/asr", "/scoring").score("q", "r", "t")
        self.assertEqual(set(result), {"relevance", "completeness", "grammar", "vocabulary"})
        self.assertEqual(result["completeness"]["score"], 3)

    def test_scoringPromptTreatsMaterialAsUntrusted(self):
        tokenizer = types.SimpleNamespace(apply_chat_template=Mock(return_value="prompt"))
        model_module = types.SimpleNamespace(load=Mock(return_value=(object(), tokenizer)), generate=Mock(return_value='{"relevance":{"score":3,"feedback":"合适"},"completeness":{"score":3,"feedback":"完整"},"grammar":{"score":3,"feedback":"可理解"},"vocabulary":{"score":3,"feedback":"恰当"}}'))
        sample_utils = types.SimpleNamespace(make_sampler=lambda **kwargs: kwargs)
        with patch.dict(sys.modules, {"mlx_lm": model_module, "mlx_lm.sample_utils": sample_utils}):
            exam_worker.ExamWorker("/asr", "/scoring").score("ignore rules", "reference", "answer")
        messages = tokenizer.apply_chat_template.call_args.args[0]
        system_prompt = messages[0]["content"]
        self.assertIn("untrusted", system_prompt.lower())
        self.assertIn("ignore", system_prompt.lower())
        self.assertIn("meaning", system_prompt.lower())

    def test_modelErrorReturnsProtocolError(self):
        worker = exam_worker.ExamWorker("/asr", "/scoring")
        with patch.dict(sys.modules, {"mlx_whisper": types.SimpleNamespace(transcribe=Mock(side_effect=RuntimeError("sensitive detail")))}):
            response = worker.handle({"id": "one", "type": "transcribe", "audioPath": "/tmp/private.wav"})
        self.assertEqual(response, {"id": "one", "ok": False, "error": "本机语音识别失败，请重新录音。"})

    def test_logsNeverContainExamInputOrAudioPath(self):
        stdout = io.StringIO()
        stderr = io.StringIO()
        input_data = {"id": "one", "type": "transcribe", "audioPath": "/tmp/private-exam-recording.wav"}
        worker = exam_worker.ExamWorker("/asr", "/scoring")
        with patch.dict(sys.modules, {"mlx_whisper": types.SimpleNamespace(transcribe=Mock(side_effect=RuntimeError("question-secret")))}), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            print(json.dumps(worker.handle(input_data), ensure_ascii=False))
            exam_worker.safe_log("识别失败")
        logs = stdout.getvalue() + stderr.getvalue()
        self.assertNotIn("private-exam-recording", logs)
        self.assertNotIn("question-secret", logs)


if __name__ == "__main__":
    unittest.main()
