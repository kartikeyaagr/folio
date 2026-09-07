'use client';

import { type ReactNode, useEffect, useRef } from 'react';

/**
 * A button that opens a native <dialog> holding whatever it was given.
 *
 * The contents are ordinary server-rendered markup — a form with a server action, usually — so the
 * dialog owns nothing but the opening and closing. A submit inside closes it; a failed action that
 * comes back with an error can pass `open` to reopen it with the message showing.
 */
export function DialogButton({
  label,
  title,
  children,
  className = 'btn',
  open = false,
  wide = false,
  buttonTitle,
}: {
  label: ReactNode;
  title: string;
  children: ReactNode;
  className?: string;
  open?: boolean;
  wide?: boolean;
  buttonTitle?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (open && ref.current && !ref.current.open) ref.current.showModal();
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={className}
        title={buttonTitle}
        onClick={() => ref.current?.showModal()}
      >
        {label}
      </button>
      <dialog
        ref={ref}
        className={wide ? 'dlg dlg-wide' : 'dlg'}
        onClick={(e) => {
          if (e.target === ref.current) ref.current?.close();
        }}
        onSubmit={() => setTimeout(() => ref.current?.close(), 0)}
      >
        <div className="dlg-head">
          <h2>{title}</h2>
          <button
            type="button"
            className="dlg-x"
            aria-label="Close"
            onClick={() => ref.current?.close()}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="dlg-body">{children}</div>
      </dialog>
    </>
  );
}
