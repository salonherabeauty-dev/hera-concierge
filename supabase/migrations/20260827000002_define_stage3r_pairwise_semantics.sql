begin;

comment on column public.ai_stage3r_case_results.candidate_preference_rate is
  'Versioned Stage 3-R pairwise metric. For hera-stage3r-2026-08-27.2 and later, this is candidate non-inferiority: candidate or tie divided by all primary pairwise judgements; reference counts zero. Older immutable runs retain the semantics recorded in their run contract.';

comment on column public.ai_stage3r_case_results.position_consistent is
  'Versioned Stage 3-R material position-consistency result. For hera-stage3r-2026-08-27.2 and later, tie-to-decisive is compatible, candidate-to-reference is a material reversal, score movement above one is material, and raw judge preferences remain preserved for strict recomputation.';

comment on column public.ai_stage3r_case_results.repeated_judge_consistent is
  'Versioned Stage 3-R material repeat-consistency result. Raw judge preferences, scores and flags remain preserved in judge_results for strict recomputation.';

commit;
