"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

// 화면 상태: A(idle, 업로드 대기) → B(uploading, 분석 중) → 완료/에러
type ScreenState = "idle" | "uploading" | "done" | "error";

type DetailedSummary = {
  keyTerms: string;
  motivation: string;
  methodResults: string;
  conclusion: string;
};

type UploadResult = {
  filename: string;
  size: number;
  pageCount: number;
  pages: { num: number; text: string }[];
  text: string;
  summary: string;
  detailedSummary: DetailedSummary;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  pages?: number[];
};

const DETAILED_SUMMARY_SECTIONS: { key: keyof DetailedSummary; label: string }[] = [
  { key: "keyTerms", label: "Key Terms & Definitions" },
  { key: "motivation", label: "Motivation & Problem Statement" },
  { key: "methodResults", label: "Method & Key Results" },
  { key: "conclusion", label: "Conclusion & Impact" },
];

function isPdfFile(file: File) {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
}

export default function Home() {
  const [state, setState] = useState<ScreenState>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [result, setResult] = useState<UploadResult | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [activeTab, setActiveTab] = useState(0);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  // 96시간 이내 재접속이면 세션 쿠키로 이전 논문·요약·대화를 이어서 보여준다 (PLAN 14)
  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      try {
        const response = await fetch("/api/session");
        const data = await response.json();

        if (!cancelled && data?.exists) {
          setResult({
            filename: data.filename,
            size: data.size,
            pageCount: data.pageCount,
            pages: data.pages,
            text: data.text,
            summary: data.summary,
            detailedSummary: data.detailedSummary,
          });
          setChatMessages(data.chatMessages ?? []);
          setState("done");
        }
      } catch {
        // 복원 실패 시 그냥 업로드 화면(idle)으로 둔다
      } finally {
        if (!cancelled) setCheckingSession(false);
      }
    }

    restoreSession();
    return () => {
      cancelled = true;
    };
  }, []);

  async function uploadFile(file: File) {
    if (!isPdfFile(file)) {
      setErrorMessage("PDF 파일만 업로드할 수 있습니다");
      setState("error");
      return;
    }

    setState("uploading");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/analyze", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setErrorMessage(body?.message ?? "일시적인 오류가 발생했습니다. 다시 시도해주세요");
        setState("error");
        return;
      }

      const data = (await response.json()) as UploadResult;
      setResult(data);
      setState("done");
    } catch {
      setErrorMessage("일시적인 오류가 발생했습니다. 다시 시도해주세요");
      setState("error");
    }
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) uploadFile(file);
    event.target.value = "";
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file) uploadFile(file);
  }

  function reset() {
    setState("idle");
    setErrorMessage("");
    setResult(null);
    setActiveTab(0);
    setChatMessages([]);
    setChatInput("");
    setChatSending(false);
  }

  async function handleChatSubmit(event: React.FormEvent) {
    event.preventDefault();
    const question = chatInput.trim();
    if (!question || chatSending || !result) return;

    setChatMessages((prev) => [...prev, { role: "user", content: question }]);
    setChatInput("");
    setChatSending(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, paperText: result.text }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        const message = data?.message ?? "일시적인 오류가 발생했습니다. 다시 시도해주세요";
        setChatMessages((prev) => [...prev, { role: "assistant", content: message }]);
        return;
      }

      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.answer, pages: data.pages ?? [] },
      ]);
    } catch {
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: "일시적인 오류가 발생했습니다. 다시 시도해주세요" },
      ]);
    } finally {
      setChatSending(false);
    }
  }

  return (
    <div className={styles.page}>
      <main className={`${styles.main} ${state === "done" ? styles.mainWide : ""}`}>
        {state !== "done" && <h1 className={styles.title}>논문 리딩 어시스턴트</h1>}

        {checkingSession && (
          <div className={styles.dropzone}>
            <p className={styles.dropzoneText}>이전 세션을 확인하고 있습니다...</p>
          </div>
        )}

        {!checkingSession && state !== "uploading" && state !== "done" && (
          <div
            className={`${styles.dropzone} ${isDragOver ? styles.dropzoneActive : ""}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
          >
            <p className={styles.dropzoneText}>
              PDF 파일을 여기로 끌어다 놓거나 클릭하세요
            </p>
            <p className={styles.dropzoneHint}>PDF만, 최대 30페이지</p>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf"
              className={styles.hiddenInput}
              onChange={handleFileChange}
            />
          </div>
        )}

        {state === "uploading" && (
          <div className={styles.dropzone}>
            <p className={styles.dropzoneText}>논문을 분석하고 있습니다...</p>
          </div>
        )}

        {state === "error" && <p className={styles.errorText}>{errorMessage}</p>}

        {state === "done" && result && (
          <div className={styles.resultLayout}>
            <div className={styles.resultTopBar}>
              <div>
                <p className={styles.resultFilename}>{result.filename}</p>
                <p className={styles.resultMeta}>
                  {Math.round(result.size / 1024)}KB · 총 {result.pageCount}페이지
                </p>
              </div>
              <button className={styles.resetButton} onClick={reset}>
                새 논문 업로드
              </button>
            </div>

            <div className={styles.resultBody}>
              <div className={styles.resultLeft}>
                <div className={styles.summaryBox}>
                  <p className={styles.previewTitle}>핵심 요약 (500자 이내)</p>
                  <p className={styles.summaryText}>{result.summary}</p>
                </div>

                <div className={styles.summaryBox}>
                  <div className={styles.tabList}>
                    {DETAILED_SUMMARY_SECTIONS.map((section, index) => (
                      <button
                        key={section.key}
                        className={`${styles.tabButton} ${
                          activeTab === index ? styles.tabButtonActive : ""
                        }`}
                        onClick={() => setActiveTab(index)}
                      >
                        {section.label}
                      </button>
                    ))}
                  </div>
                  <div className={styles.tabPanel}>
                    <p className={styles.summaryText}>
                      {result.detailedSummary[DETAILED_SUMMARY_SECTIONS[activeTab].key]}
                    </p>
                  </div>
                </div>

                <div className={styles.preview}>
                  <p className={styles.previewTitle}>추출된 텍스트 미리보기</p>
                  <div className={styles.previewScroll}>
                    {result.pages.map((page) => (
                      <div key={page.num} className={styles.previewPage}>
                        <p className={styles.previewPageNum}>{page.num}페이지</p>
                        <p className={styles.previewPageText}>{page.text}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className={styles.resultRight}>
                <div className={styles.chatPanel}>
                  <p className={styles.previewTitle}>Q&amp;A 채팅</p>
                  <div className={styles.chatMessages}>
                    {chatMessages.length === 0 && (
                      <p className={styles.chatEmpty}>
                        업로드한 논문에 대해 궁금한 점을 물어보세요.
                      </p>
                    )}
                    {chatMessages.map((message, index) => (
                      <div
                        key={index}
                        className={`${styles.chatMessage} ${
                          message.role === "user"
                            ? styles.chatMessageUser
                            : styles.chatMessageAssistant
                        }`}
                      >
                        <p className={styles.chatBubble}>{message.content}</p>
                        {message.pages && message.pages.length > 0 && (
                          <div className={styles.chatPageBadges}>
                            {message.pages.map((pageNum) => (
                              <span key={pageNum} className={styles.chatPageBadge}>
                                {pageNum}페이지 참고
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                    {chatSending && (
                      <div className={`${styles.chatMessage} ${styles.chatMessageAssistant}`}>
                        <p className={styles.chatBubble}>답변을 생성하고 있습니다...</p>
                      </div>
                    )}
                  </div>
                  <form className={styles.chatForm} onSubmit={handleChatSubmit}>
                    <input
                      type="text"
                      className={styles.chatInput}
                      placeholder="논문에 대해 질문해보세요"
                      value={chatInput}
                      onChange={(event) => setChatInput(event.target.value)}
                      disabled={chatSending}
                    />
                    <button
                      type="submit"
                      className={styles.chatSendButton}
                      disabled={!chatInput.trim() || chatSending}
                    >
                      전송
                    </button>
                  </form>
                </div>
              </div>
            </div>
          </div>
        )}

        <p className={styles.notice}>
          ※ 업로드한 논문은 96시간 후 자동 삭제됩니다. 본 서비스는 학습·연구
          보조 도구이며, 정당한 접근 권한이 있는 논문만 업로드해 주세요
          (저작권 책임은 업로더에게 있습니다).
        </p>
      </main>
    </div>
  );
}
