'use client';

import Link from 'next/link';
import { ArrowRight, Clock, Globe } from 'lucide-react';

interface SessionCardProps {
  id: string;
  title: string;
  date: string;
  duration: string;
  tags: string[];
  sourceLang: string;
  targetLang: string;
}

export default function SessionCard({
  id,
  title,
  date,
  duration,
  tags,
  sourceLang,
  targetLang,
}: SessionCardProps) {
  return (
    <Link
      href={`/session/${id}`}
      className="group flex items-center justify-between py-5 px-2 border-b border-cream-200
                 hover:bg-cream-50 transition-all duration-200 -mx-2 rounded-lg card-hover-lift"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-3 text-xs text-charcoal-400 mb-1.5">
          <span className="uppercase tracking-wider">{date}</span>
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {duration}
          </span>
        </div>
        <h3 className="font-serif text-lg font-semibold text-charcoal-800 group-hover:text-rust-600 transition-colors truncate">
          {title}
        </h3>
        <div className="flex items-center gap-2 mt-2">
          {tags.map((tag) => (
            <span key={tag} className="tag-badge">{tag}</span>
          ))}
          <span className="flex items-center gap-1 text-xs text-charcoal-400">
            <Globe className="w-3 h-3" />
            {sourceLang.toUpperCase()} → {targetLang.toUpperCase()}
          </span>
        </div>
      </div>
      <ArrowRight className="w-5 h-5 text-charcoal-300 group-hover:text-rust-500 transition-colors flex-shrink-0 ml-4" />
    </Link>
  );
}
