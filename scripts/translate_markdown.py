#!/usr/bin/env python3

from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path

from deep_translator import GoogleTranslator


BLOCK_TOKEN_RE = re.compile(r"PHXBLOCK\d{5}PHX")
INLINE_TOKEN_RE = re.compile(r"PHX(?:URL|CODE)\d{5}PHX")
HTML_TOKEN_RE = re.compile(r"PHXHTML\d{5}PHX")
LIST_RE = re.compile(r"^(\s*)([-*+]|\d+\.)\s+(.*)$")
ORDERED_PAREN_RE = re.compile(r"^(\s*)(\d+\))\s+(.*)$")
HR_RE = re.compile(r"^\s*([-*_]\s*){3,}\s*$")
TABLE_ALIGN_RE = re.compile(r"^[\s|:-]+$")
REFERENCE_LINK_RE = re.compile(r"^(\s*\[[^\]]+]:\s*)(\S+)(.*)$")
ATTR_URL_RE = re.compile(r'(\b(?:href|src)=)(["\'])(.*?)(\2)')
MD_LINK_DEST_RE = re.compile(r"(!?\[[^\]]*]\()(<[^>]+>|[^)\s]+)(\s+(?:\"[^\"]*\"|'[^']*'))?(\))")
NAKED_URL_RE = re.compile(r"(?<![\"'=])(https?://[^\s<>()]+|www\.[^\s<>()]+)")
INLINE_CODE_RE = re.compile(r"(`+)([^`\n]+?)(\1)")
FENCED_BLOCK_RE = re.compile(r"(^```[^\n]*\n.*?^```[ \t]*$|^~~~[^\n]*\n.*?^~~~[ \t]*$)", re.MULTILINE | re.DOTALL)
HTML_TAG_RE = re.compile(r"</?[^>]+?>", re.DOTALL)


class PlaceholderStore:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.counter = 0

    def add(self, kind: str, value: str) -> str:
        token = f"PHX{kind}{self.counter:05d}PHX"
        self.values[token] = value
        self.counter += 1
        return token

    def restore(self, text: str) -> str:
        for token, value in self.values.items():
            text = text.replace(token, value)
        return text


class MarkdownTranslator:
    def __init__(self, source_lang: str, target_lang: str, chunk_limit: int = 3200) -> None:
        self.translator = GoogleTranslator(source=source_lang, target=target_lang, timeout=12)
        self.cache: dict[str, str] = {}
        self.chunk_limit = chunk_limit

    def translate(self, text: str) -> str:
        if not self._should_translate(text):
            return text
        if text in self.cache:
            return self.cache[text]
        translated = self._translate_with_retry(text)
        self.cache[text] = translated
        return translated

    def translate_many(self, texts: list[str]) -> list[str]:
        results = list(texts)
        pending: list[tuple[int, str]] = []
        for index, text in enumerate(texts):
            if not self._should_translate(text):
                continue
            cached = self.cache.get(text)
            if cached is not None:
                results[index] = cached
                continue
            if len(text) > self.chunk_limit:
                translated = self.translate(text)
                results[index] = translated
                continue
            pending.append((index, text))

        for batch_start in range(0, len(pending), 24):
            batch = pending[batch_start : batch_start + 24]
            payload = [text for _, text in batch]
            translated_batch = self._translate_batch_with_retry(payload)
            for (index, original), translated in zip(batch, translated_batch, strict=True):
                self.cache[original] = translated
                results[index] = translated

        return results

    def _translate_with_retry(self, text: str) -> str:
        chunks = self._chunk_text(text)
        out: list[str] = []
        for chunk in chunks:
            last_exc: Exception | None = None
            for attempt in range(5):
                try:
                    out.append(self.translator.translate(chunk))
                    break
                except Exception as exc:  # pragma: no cover - network retries
                    last_exc = exc
                    time.sleep(1.5 * (attempt + 1))
            else:
                raise RuntimeError(f"translation failed after retries: {last_exc}") from last_exc
        return "".join(out)

    def _translate_batch_with_retry(self, texts: list[str]) -> list[str]:
        last_exc: Exception | None = None
        for attempt in range(5):
            try:
                return self.translator.translate_batch(texts)
            except Exception as exc:  # pragma: no cover - network retries
                last_exc = exc
                time.sleep(1.5 * (attempt + 1))
        raise RuntimeError(f"batch translation failed after retries: {last_exc}") from last_exc

    def _chunk_text(self, text: str) -> list[str]:
        if len(text) <= self.chunk_limit:
            return [text]
        chunks: list[str] = []
        current = ""
        for sentence in re.split(r"(?<=[.!?])\s+", text):
            if not sentence:
                continue
            if len(current) + len(sentence) + 1 <= self.chunk_limit:
                current = f"{current} {sentence}".strip()
                continue
            if current:
                chunks.append(current)
            if len(sentence) <= self.chunk_limit:
                current = sentence
                continue
            for piece in re.split(r"(?<=,)\s+", sentence):
                if len(piece) <= self.chunk_limit:
                    chunks.append(piece)
                    continue
                for idx in range(0, len(piece), self.chunk_limit):
                    chunks.append(piece[idx : idx + self.chunk_limit])
            current = ""
        if current:
            chunks.append(current)
        return chunks

    @staticmethod
    def _should_translate(text: str) -> bool:
        stripped = text.strip()
        if not stripped:
            return False
        if BLOCK_TOKEN_RE.fullmatch(stripped):
            return False
        if HR_RE.fullmatch(stripped):
            return False
        return re.search(r"[A-Za-z]", stripped) is not None


def protect_placeholders(text: str, store: PlaceholderStore) -> str:
    text = FENCED_BLOCK_RE.sub(lambda m: store.add("BLOCK", m.group(0)), text)
    text = INLINE_CODE_RE.sub(lambda m: store.add("CODE", m.group(0)), text)
    text = HTML_TAG_RE.sub(lambda m: store.add("HTML", m.group(0)), text)
    text = ATTR_URL_RE.sub(
        lambda m: f"{m.group(1)}{m.group(2)}{store.add('URL', m.group(3))}{m.group(4)}",
        text,
    )
    text = MD_LINK_DEST_RE.sub(
        lambda m: f"{m.group(1)}{store.add('URL', m.group(2))}{m.group(3) or ''}{m.group(4)}",
        text,
    )
    text = REFERENCE_LINK_RE.sub(lambda m: f"{m.group(1)}{store.add('URL', m.group(2))}{m.group(3)}", text)
    text = NAKED_URL_RE.sub(lambda m: store.add("URL", m.group(1)), text)
    return text


def translate_markdown(text: str, translator: MarkdownTranslator) -> str:
    store = PlaceholderStore()
    protected = protect_placeholders(text, store)
    parts = re.split(r"(\n\s*\n+)", protected)
    ops: list[dict[str, object]] = []
    texts_to_translate: list[str] = []

    for part in parts:
        if not part:
            continue
        if re.fullmatch(r"\n\s*\n+", part):
            ops.append({"kind": "separator", "value": part})
            continue
        op = prepare_block(part)
        ops.append(op)
        texts_to_translate.extend(op.get("texts", []))

    translated_texts = iter(translator.translate_many(texts_to_translate))
    rendered: list[str] = []
    for op in ops:
        rendered.append(render_block(op, translated_texts))
    return store.restore("".join(rendered))


def match_list_prefix(line: str) -> re.Match[str] | None:
    return LIST_RE.match(line) or ORDERED_PAREN_RE.match(line)


def prepare_block(block: str) -> dict[str, object]:
    stripped = block.strip()
    if not stripped or BLOCK_TOKEN_RE.fullmatch(stripped) or HR_RE.fullmatch(stripped):
        return {"kind": "raw", "value": block}

    lines = block.splitlines()
    nonempty = [line for line in lines if line.strip()]
    if nonempty and all(line.lstrip().startswith("|") for line in nonempty):
        rows: list[dict[str, object]] = []
        texts: list[str] = []
        for line in lines:
            row, row_texts = prepare_table_row(line)
            rows.append(row)
            texts.extend(row_texts)
        return {"kind": "table", "rows": rows, "texts": texts}
    if nonempty and all(line.lstrip().startswith(">") for line in nonempty):
        body = " ".join(re.sub(r"^\s*>\s?", "", line).strip() for line in nonempty)
        return {"kind": "quote", "prefix": "> ", "texts": [body]}
    if nonempty and match_list_prefix(nonempty[0]):
        items, texts = prepare_list_items(lines)
        return {"kind": "list", "items": items, "texts": texts}
    if stripped.startswith("#"):
        combined = " ".join(line.strip() for line in lines)
        match = re.match(r"^(#+\s+)(.*)$", combined)
        if match:
            wrapped = re.match(r"^(PHXHTML\d{5}PHX)(.*?)(PHXHTML\d{5}PHX)$", match.group(2))
            if wrapped:
                return {
                    "kind": "wrapped_heading",
                    "prefix": match.group(1),
                    "before": wrapped.group(1),
                    "after": wrapped.group(3),
                    "texts": [wrapped.group(2)],
                }
            return {"kind": "heading", "prefix": match.group(1), "texts": [match.group(2)]}
    return {"kind": "paragraph", "texts": [" ".join(line.strip() for line in lines)]}


def prepare_list_items(lines: list[str]) -> tuple[list[dict[str, str]], list[str]]:
    items: list[dict[str, str]] = []
    texts: list[str] = []
    current_prefix: str | None = None
    current_body: list[str] = []

    def flush() -> None:
        nonlocal current_prefix, current_body
        if current_prefix is None:
            return
        text = " ".join(part.strip() for part in current_body if part.strip())
        items.append({"type": "item", "prefix": current_prefix, "text": text})
        texts.append(text)
        current_prefix = None
        current_body = []

    for line in lines:
        if not line.strip():
            flush()
            items.append({"type": "blank", "value": ""})
            continue
        match = match_list_prefix(line)
        if match:
            flush()
            current_prefix = f"{match.group(1)}{match.group(2)} "
            current_body = [match.group(3)]
            continue
        if current_prefix is not None:
            current_body.append(line.strip())
            continue
        items.append({"type": "raw", "value": line})
        texts.append(line)

    flush()
    return items, texts


def prepare_table_row(line: str) -> tuple[dict[str, object], list[str]]:
    stripped = line.strip()
    if not stripped or TABLE_ALIGN_RE.fullmatch(stripped):
        return {"type": "raw", "value": line}, []
    leading = "| " if line.startswith("|") else ""
    trailing = " |" if line.endswith("|") else ""
    content = line[1:] if line.startswith("|") else line
    content = content[:-1] if content.endswith("|") else content
    cells = [cell.strip() for cell in content.split("|")]
    texts = [cell for cell in cells if cell]
    return {"type": "cells", "leading": leading, "trailing": trailing, "cells": cells}, texts


def render_block(op: dict[str, object], translated_texts: object) -> str:
    kind = op["kind"]
    if kind == "separator" or kind == "raw":
        return str(op["value"])
    if kind == "heading":
        return f"{op['prefix']}{next(translated_texts)}"
    if kind == "wrapped_heading":
        return f"{op['prefix']}{op['before']}{next(translated_texts)}{op['after']}"
    if kind == "quote":
        return f"{op['prefix']}{next(translated_texts)}"
    if kind == "paragraph":
        return next(translated_texts)
    if kind == "list":
        rendered_items: list[str] = []
        for item in op["items"]:  # type: ignore[index]
            item_type = item["type"]
            if item_type == "blank":
                rendered_items.append("")
            elif item_type == "raw":
                rendered_items.append(next(translated_texts))
            else:
                rendered_items.append(f"{item['prefix']}{next(translated_texts)}".rstrip())
        return "\n".join(rendered_items)
    if kind == "table":
        rendered_rows: list[str] = []
        for row in op["rows"]:  # type: ignore[index]
            if row["type"] == "raw":
                rendered_rows.append(str(row["value"]))
                continue
            row_cells = []
            for cell in row["cells"]:  # type: ignore[index]
                row_cells.append(next(translated_texts) if cell else cell)
            rendered_rows.append(f"{row['leading']}{' | '.join(row_cells)}{row['trailing']}".rstrip())
        return "\n".join(rendered_rows)
    raise ValueError(f"unknown block kind: {kind}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Translate Markdown while preserving code and links.")
    parser.add_argument("--source-lang", default="en")
    parser.add_argument("--target-lang", default="ko")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("files", nargs="+")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    translator = MarkdownTranslator(args.source_lang, args.target_lang)

    for file_arg in args.files:
        src = Path(file_arg)
        if not src.exists():
            print(f"skip missing: {src}", file=sys.stderr)
            continue
        translated = translate_markdown(src.read_text(encoding="utf-8"), translator)
        dest = output_dir / src.name
        dest.write_text(translated + ("" if translated.endswith("\n") else "\n"), encoding="utf-8")
        print(dest)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
