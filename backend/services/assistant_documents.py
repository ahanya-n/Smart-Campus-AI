"""Private, local-only document extraction and study aids."""

import re
import zipfile
from collections import Counter
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree

from fastapi import HTTPException, UploadFile

MAX_DOCUMENT_BYTES = 5 * 1024 * 1024
MAX_EXTRACTED_CHARACTERS = 300_000
MAX_PDF_PAGES = 1_000
MAX_DOCX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024

_MIME_TYPES = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain",
}
_STOP_WORDS = {
    "about", "after", "again", "also", "and", "are", "because", "been", "before",
    "being", "between", "but", "can", "could", "each", "for", "from", "have",
    "into", "its", "more", "most", "not", "our", "over", "same", "should",
    "such", "than", "that", "the", "their", "them", "then", "there", "these",
    "they", "this", "those", "through", "under", "use", "used", "using", "was",
    "were", "what", "when", "where", "which", "while", "with", "would", "your",
}


async def extract_uploaded_document(file: UploadFile) -> tuple[str, str, int]:
    """Validate a small PDF/DOCX/TXT upload and extract text without executing it."""
    filename = (file.filename or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    extension = Path(filename).suffix.lower()
    if extension not in _MIME_TYPES:
        raise HTTPException(status_code=415, detail="Only PDF, DOCX, and TXT files are supported.")

    content_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    expected_type = _MIME_TYPES[extension]
    if content_type not in {"", "application/octet-stream", expected_type}:
        raise HTTPException(status_code=415, detail="The file type does not match its extension.")

    payload = await file.read(MAX_DOCUMENT_BYTES + 1)
    if not payload:
        raise HTTPException(status_code=422, detail="The uploaded document is empty.")
    if len(payload) > MAX_DOCUMENT_BYTES:
        raise HTTPException(status_code=413, detail="Documents must be 5 MB or smaller.")

    if extension == ".pdf":
        text = _extract_pdf(payload)
    elif extension == ".docx":
        text = _extract_docx(payload)
    else:
        if b"\x00" in payload:
            raise HTTPException(status_code=415, detail="The TXT file contains binary data.")
        try:
            text = payload.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise HTTPException(status_code=415, detail="TXT files must use UTF-8 encoding.") from error
        if any(ord(char) < 32 and char not in "\t\n\r\f" for char in text):
            raise HTTPException(status_code=415, detail="The TXT file contains unsupported control data.")

    text = re.sub(r"[ \t]+\n", "\n", text).strip()
    if not text:
        raise HTTPException(status_code=422, detail="No readable text was found in the document.")
    if len(text) > MAX_EXTRACTED_CHARACTERS:
        raise HTTPException(status_code=413, detail="The extracted document text is too large.")
    return filename[:255], text, len(payload)


def _extract_pdf(payload: bytes) -> str:
    if b"%PDF-" not in payload[:1024]:
        raise HTTPException(status_code=415, detail="The file is not a valid PDF.")
    try:
        from pypdf import PdfReader

        reader = PdfReader(BytesIO(payload), strict=False)
        if reader.is_encrypted:
            raise HTTPException(status_code=422, detail="Encrypted PDFs are not supported.")
        if len(reader.pages) > MAX_PDF_PAGES:
            raise HTTPException(status_code=413, detail="PDFs are limited to 1,000 pages.")
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=422, detail="The PDF could not be safely read.") from error


def _extract_docx(payload: bytes) -> str:
    try:
        with zipfile.ZipFile(BytesIO(payload)) as archive:
            entries = archive.infolist()
            if (
                len(entries) > 2_000
                or sum(entry.file_size for entry in entries) > MAX_DOCX_UNCOMPRESSED_BYTES
                or any("vbaproject" in entry.filename.lower() for entry in entries)
                or "word/document.xml" not in archive.namelist()
                or "[Content_Types].xml" not in archive.namelist()
            ):
                raise HTTPException(status_code=415, detail="The DOCX package is invalid or unsupported.")
            document_info = archive.getinfo("word/document.xml")
            if document_info.file_size > MAX_EXTRACTED_CHARACTERS * 4:
                raise HTTPException(status_code=413, detail="The DOCX document text is too large.")
            root = ElementTree.fromstring(archive.read(document_info))
    except HTTPException:
        raise
    except (OSError, KeyError, zipfile.BadZipFile, ElementTree.ParseError) as error:
        raise HTTPException(status_code=422, detail="The DOCX file could not be safely read.") from error

    text_tag = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"
    paragraph_tag = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p"
    paragraphs = []
    for paragraph in root.iter(paragraph_tag):
        content = "".join(node.text or "" for node in paragraph.iter(text_tag)).strip()
        if content:
            paragraphs.append(content)
    return "\n".join(paragraphs)


def summarize_text(text: str, limit: int = 4) -> str:
    """Return a short deterministic extractive summary; no text leaves the service."""
    sentences = [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?])\s+|\n+", text)
        if len(sentence.split()) >= 5
    ]
    if not sentences:
        return " ".join(text.split()[:60])

    terms = [
        word.casefold()
        for word in re.findall(r"\b[\w+#.-]{4,}\b", text)
        if word.casefold() not in _STOP_WORDS
    ]
    frequencies = Counter(terms)

    def score(sentence: str) -> float:
        words = [
            word.casefold()
            for word in re.findall(r"\b[\w+#.-]{4,}\b", sentence)
            if word.casefold() not in _STOP_WORDS
        ]
        return sum(frequencies[word] for word in words) / max(len(words), 1)

    selected = sorted(sorted(enumerate(sentences), key=lambda item: score(item[1]), reverse=True)[:limit])
    return " ".join(sentence for _, sentence in selected)


def build_quiz(text: str, limit: int = 5) -> list[dict[str, str]]:
    questions = []
    seen_answers = set()
    for sentence in re.split(r"(?<=[.!?])\s+|\n+", text):
        words = re.findall(r"\b[A-Za-z][A-Za-z0-9+#.-]{3,}\b", sentence)
        candidates = [
            word for word in words
            if word.casefold() not in _STOP_WORDS and word.casefold() not in seen_answers
        ]
        if len(words) < 6 or not candidates:
            continue
        answer = max(candidates, key=len)
        question = re.sub(re.escape(answer), "____", sentence, count=1, flags=re.IGNORECASE)
        questions.append({"question": f"Complete the statement: {question}", "answer": answer})
        seen_answers.add(answer.casefold())
        if len(questions) >= limit:
            break
    return questions


def build_flashcards(text: str, limit: int = 10) -> list[dict[str, str]]:
    cards = []
    definition_pattern = re.compile(
        r"\b(?P<term>[A-Za-z][A-Za-z0-9+#.-]{2,})\s+"
        r"(?:is|are|means|refers to|describes|consists of)\s+(?P<definition>[^.!?]{8,}[.!?]?)",
        re.IGNORECASE,
    )
    for match in definition_pattern.finditer(text):
        cards.append({
            "front": f"What is {match.group('term')}?",
            "back": match.group(0).strip(),
        })
        if len(cards) >= limit:
            break
    return cards


def analyze_study_text(filename: str, text: str) -> dict:
    """Create a deterministic, document-grounded study analysis."""
    sentences = [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?])\s+|\n+", text)
        if len(sentence.split()) >= 4
    ]
    words = [
        word.casefold()
        for word in re.findall(r"\b[A-Za-z][A-Za-z0-9+#.-]{3,}\b", text)
        if word.casefold() not in _STOP_WORDS
    ]
    frequencies = Counter(words)
    topics = [word.title() for word, _ in frequencies.most_common(12)]
    key_concepts = [word.title() for word, _ in frequencies.most_common(8)]
    definitions = build_flashcards(text, 8)
    important_points = sentences[:8]
    exam_sources = sentences[:12]

    questions = []
    for index, sentence in enumerate(exam_sources[:6], start=1):
        answer_words = re.findall(r"\b[A-Za-z][A-Za-z0-9+#.-]{3,}\b", sentence)
        candidates = [
            word for word in answer_words
            if word.casefold() not in _STOP_WORDS
        ]
        if not candidates:
            continue
        topic = candidates[-1]
        questions.append({
            "marks": (2, 5, 7.5, 10)[(index - 1) % 4],
            "question": f"Explain {topic} with reference to the uploaded material.",
            "answer": sentence,
        })

    mcqs = []
    for index, sentence in enumerate(exam_sources[:5], start=1):
        candidates = re.findall(r"\b[A-Za-z][A-Za-z0-9+#.-]{3,}\b", sentence)
        candidates = [word for word in candidates if word.casefold() not in _STOP_WORDS]
        if not candidates:
            continue
        answer = candidates[-1]
        mcqs.append({
            "question": f"Which term is associated with this statement: {sentence}",
            "options": [answer, "Not stated in the document", "Insufficient information", "General knowledge"],
            "answer": answer,
            "explanation": f"The uploaded text states: {sentence}",
        })

    return {
        "document": {
            "name": filename,
            "word_count": len(re.findall(r"\b[\w'-]+\b", text)),
            "extracted_text_available": bool(sentences),
            "main_subject": topics[0] if topics else "Insufficient information",
            "summary": summarize_text(text),
            "extracted_text_preview": text[:5_000],
        },
        "chapter_topic_analysis": {
            "chapters_detected": [],
            "main_topics": topics[:6],
            "important_subtopics": topics[6:12],
            "key_concepts": key_concepts,
            "important_definitions": definitions,
        },
        "important_material": {
            "important_points": important_points,
            "formulas": sorted(set(re.findall(r"[A-Za-z]+\s*=\s*[A-Za-z0-9()+*/.^-]+", text)))[:20],
            "examples": [
                sentence for sentence in sentences
                if re.search(r"\b(example|for instance|such as|e\.g\.)\b", sentence, re.I)
            ][:10],
            "topics_for_more_attention": topics[8:12],
        },
        "sample_exam_questions": {
            "questions": questions,
            "mcqs": mcqs,
        },
    }


def answer_study_question(text: str, question: str, filename: str) -> str:
    """Answer from the most relevant extracted sentences, without external processing."""
    sentences = [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?])\s+|\n+", text)
        if len(sentence.split()) >= 4
    ]
    ignored_terms = _STOP_WORDS | {
        "explain", "describe", "define", "discuss", "give", "make", "generate",
        "create", "write", "answer", "question", "questions", "notes", "note",
        "revision", "summary", "summarize", "mcq", "mcqs", "quiz", "ten", "mark",
        "marks", "five", "two", "short", "long", "please", "document", "material",
        "uploaded", "based",
    }
    terms = {
        word.casefold()
        for word in re.findall(r"\b[\w+#.-]{3,}\b", question)
        if word.casefold() not in ignored_terms
    }
    if not sentences or not terms:
        return (
            f"I could not identify a specific topic to answer from '{filename}'. "
            "Ask about a term or concept that appears in the uploaded document."
        )

    ranked = []
    for index, sentence in enumerate(sentences):
        words = {
            word.casefold()
            for word in re.findall(r"\b[\w+#.-]{3,}\b", sentence)
        }
        overlap = terms & words
        if overlap:
            ranked.append((len(overlap) / len(terms), len(overlap), -index, sentence))
    if not ranked:
        return (
            f"I could not find information about that topic in '{filename}'. "
            "I have not filled the gap with outside information."
        )

    ranked.sort(reverse=True)
    selected = [item[3] for item in ranked[:5]]
    return (
        f"From the extracted text in '{filename}':\n"
        + "\n".join(f"- {sentence}" for sentence in selected)
        + "\n\nThis answer uses matching statements from your document only."
    )


def analyze_job_description(filename: str, text: str) -> dict:
    """Extract explicit job requirements and keep recommendations clearly separate."""
    sentences = [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?])\s+|\n+", text)
        if sentence.strip()
    ]
    explicit_pattern = re.compile(
        r"\b(required|requirement|must|minimum|qualification|eligible|"
        r"experience|proficien(?:t|cy)|responsibilit|you will|should have)\b",
        re.IGNORECASE,
    )
    responsibilities = [
        sentence for sentence in sentences
        if re.search(r"\b(responsibilit|you will|duties|responsible for)\b", sentence, re.I)
    ][:12]
    explicit_requirements = [
        sentence for sentence in sentences if explicit_pattern.search(sentence)
    ][:20]
    skill_names = (
        "JavaScript", "TypeScript", "Python", "Java", "C++", "C#", "SQL",
        "React", "Node.js", "Express", "FastAPI", "Django", "AWS", "Azure",
        "Docker", "Kubernetes", "Git", "Linux", "REST", "GraphQL",
        "Machine Learning", "Data Analysis", "Communication",
    )
    skills = [
        skill for skill in skill_names
        if re.search(rf"(?<!\w){re.escape(skill)}(?!\w)", text, re.IGNORECASE)
    ]
    languages_and_tools = [
        skill for skill in skills
        if skill in {
            "JavaScript", "TypeScript", "Python", "Java", "C++", "C#", "SQL",
            "React", "Node.js", "Express", "FastAPI", "Django", "AWS", "Azure",
            "Docker", "Kubernetes", "Git", "Linux", "REST", "GraphQL",
        }
    ]
    qualifications = [
        sentence for sentence in explicit_requirements
        if re.search(r"\b(degree|bachelor|master|qualification|eligible|years? of experience)\b", sentence, re.I)
    ][:10]
    interview_topics = skills[:10]
    return {
        "document": filename,
        "extracted_text_available": bool(sentences),
        "explicit_requirements": explicit_requirements,
        "qualifications_and_eligibility": qualifications,
        "technical_skills": skills,
        "languages_and_tools": languages_and_tools,
        "experience_requirements": [
            sentence for sentence in explicit_requirements
            if re.search(r"\b(experience|years?)\b", sentence, re.I)
        ][:10],
        "responsibilities": responsibilities,
        "interview_topics": interview_topics,
        "additional_recommendations": [
            f"Review {skill} fundamentals and prepare one example of applying it."
            for skill in interview_topics
        ],
        "roadmap": [
            {"week": 1, "focus": "Review explicitly listed requirements and assess current skills."},
            {"week": 2, "focus": "Practice the extracted technical skills and role-related problem solving."},
            {"week": 3, "focus": "Prepare project examples, technical explanations, and mock interview answers."},
        ],
    }
