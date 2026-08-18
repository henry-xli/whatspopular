"use client";

import { useEffect, useState } from "react";
import type { CultureQuizQuestion } from "../culture";

const QUESTION_COUNT = 5;

type RoundQuestion = CultureQuizQuestion & { shuffledAnswers: string[] };
type QuizStatus = "idle" | "active" | "complete";

function randomIndex(maximum: number) {
  if (maximum <= 1) return 0;
  const values = new Uint32Array(1);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(values);
    return values[0] % maximum;
  }
  return Math.floor(Math.random() * maximum);
}

function shuffle<T>(values: T[]) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function selectRound(questions: CultureQuizQuestion[]) {
  return shuffle(questions)
    .slice(0, Math.min(QUESTION_COUNT, questions.length))
    .map((question) => ({ ...question, shuffledAnswers: shuffle(question.answers) }));
}

function scoreRound(round: RoundQuestion[], responses: Array<string | null>) {
  return round.reduce((score, question, index) => (
    score + (responses[index] === question.correctAnswer ? 1 : 0)
  ), 0);
}

export function Quiz({ questions, durationSeconds }: { questions: CultureQuizQuestion[]; durationSeconds: number }) {
  const [status, setStatus] = useState<QuizStatus>("idle");
  const [round, setRound] = useState<RoundQuestion[]>([]);
  const [current, setCurrent] = useState(0);
  const [responses, setResponses] = useState<Array<string | null>>([]);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState(durationSeconds);

  useEffect(() => {
    if (status !== "active" || deadline === null) return undefined;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setTimeLeft(remaining);
      if (remaining === 0) {
        setStatus("complete");
        setDeadline(null);
      }
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [deadline, status]);

  function startQuiz() {
    setRound(selectRound(questions));
    setResponses([]);
    setCurrent(0);
    setTimeLeft(durationSeconds);
    setDeadline(Date.now() + durationSeconds * 1000);
    setStatus("active");
  }

  function chooseAnswer(answer: string) {
    if (status !== "active") return;
    setResponses((previous) => {
      const next = [...previous];
      next[current] = answer;
      return next;
    });
  }

  function nextQuestion() {
    if (current >= round.length - 1) {
      setStatus("complete");
      setDeadline(null);
      return;
    }
    setCurrent((previous) => previous + 1);
  }

  const question = round[current];
  const selectedAnswer = question ? responses[current] ?? null : null;
  const score = scoreRound(round, responses);

  return (
    <>
      {status === "idle" ? (
        <button className="button button-primary quiz-trigger" type="button" onClick={startQuiz}>
          Quiz me
        </button>
      ) : null}

      {status === "active" && question ? (
        <section className="quiz-panel" aria-labelledby="quiz-title">
          <div className="quiz-panel-heading">
            <div>
              <p className="eyebrow">Question {current + 1} of {round.length}</p>
              <h2 id="quiz-title">How much do you know?</h2>
            </div>
            <span className={`quiz-timer${timeLeft <= 10 ? " is-low" : ""}`} role="timer" aria-live="polite">
              {timeLeft}s
            </span>
          </div>
          <p className="quiz-topic">{question.topic}</p>
          <p className="quiz-question">{question.prompt}</p>
          <fieldset className="quiz-answers">
            <legend className="visually-hidden">Choose an answer</legend>
            {question.shuffledAnswers.map((answer) => (
              <button
                key={answer}
                className={`quiz-answer${selectedAnswer === answer ? " is-selected" : ""}`}
                type="button"
                onClick={() => chooseAnswer(answer)}
                aria-pressed={selectedAnswer === answer}
              >
                {answer}
              </button>
            ))}
          </fieldset>
          <div className="quiz-controls">
            <span>{selectedAnswer ? "Answer selected" : "Choose one answer"}</span>
            <button className="button button-primary" type="button" onClick={nextQuestion} disabled={!selectedAnswer}>
              {current === round.length - 1 ? "Finish" : "Next"}
            </button>
          </div>
        </section>
      ) : null}

      {status === "complete" ? (
        <section className="quiz-panel quiz-result" aria-labelledby="quiz-result-title" aria-live="polite">
          <p className="eyebrow">Quiz complete</p>
          <h2 id="quiz-result-title">You scored {score} / {round.length}.</h2>
          <p>{score === round.length ? "You are fully caught up." : "Explore the boards to fill in the gaps."}</p>
          <div className="quiz-controls">
            <a className="button button-quiet" href="/explore">Explore the boards</a>
            <button className="button button-primary" type="button" onClick={startQuiz}>Quiz again</button>
          </div>
        </section>
      ) : null}
    </>
  );
}
