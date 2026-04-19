# <a href="#appendix-e-version-evolution-log" class="header">부록 E: 버전 발전 로그</a>

이 책의 핵심 분석은 Claude Code v2.1.88(전체 소스 맵 포함, 4,756개의 소스 파일 복구 가능)을 기반으로 합니다. 이 부록에는 후속 버전의 주요 변경 사항과 각 장에 미치는 영향이 기록되어 있습니다.

> **탐색 팁**: 각 변경 사항은 해당 장의 버전 발전 섹션으로 연결됩니다. 이동하려면 챕터 번호를 클릭하세요.

> Anthropic은 v2.1.89부터 소스 맵 분포를 제거했기 때문에 다음 분석은 제한된 깊이의 번들 문자열 신호 비교 + v2.1.88 소스 코드 지원 추론을 기반으로 합니다.

## <a href="#v2188---v2191" class="header">v2.1.88 -&gt; v2.1.91</a>

**개요**: cli.js +115KB \| 텐구 이벤트 +39/-6 \| 환경 변수 +8/-3 \| 소스 맵이 제거되었습니다.

### <a href="#high-impact-changes" class="header">큰 영향을 미치는 변경 사항</a>

<div class="table-wrapper">

| 변화 | 영향을 받는 챕터 | 세부 |
|----|----|----|
| 트리시터 WASM 제거 | [ch16 권한 시스템](../part5/ch16.html#version-evolutionv2191-changes) | Bash 보안이 AST 분석에서 regex/shell-quote로 되돌아갔습니다. CC-643 성능 문제로 인해 |
| `"auto"` 권한 모드가 공식화되었습니다. | [ch16](../part5/ch16.html#version-evolutionv2191-changes)-[ch17](../part5/ch17.html#version-evolutionv2191-changes) 권한/YOLO | SDK 공개 API에 자동 모드가 추가되었습니다. |
| 냉압축 + 대화 + 급속 되메우기 회로 차단기 | [ch11 마이크로 압축](../part3/ch11.html#version-evolutionv2191-changes) | 지연 압축 전략 및 사용자 확인 UI 추가 |

</div>

### <a href="#medium-impact-changes" class="header">중간 정도의 영향을 미치는 변경 사항</a>

<div class="table-wrapper">

| 변화 | 영향을 받는 챕터 | 세부 |
|----|----|----|
| `staleReadFileStateHint` | [ch09](../part3/ch09.html#version-evolutionv2191-changes)-[ch10](../part3/ch10.html#version-evolutionv2191-changes) 컨텍스트 관리 | 도구 실행 중 파일 시간 변경 감지 |
| Ultraplan 원격 다중 에이전트 계획 | [ch20 에이전트 클러스터](../part6/ch20.html) | CCR 원격 세션 + Opus 4.6 + 30분 시간 초과 |
| 하위 에이전트 개선 사항 | [ch20](../part6/ch20.html)-[ch21](../part6/ch21.html#version-evolutionv2191-changes) 다중 에이전트/작업 | 회전 제한, 린 스키마, 비용 조정 |

</div>

### <a href="#low-impact-changes" class="header">영향이 적은 변경 사항</a>

<div class="table-wrapper">

| 변화 | 영향을 받는 챕터 |
|----|----|
| `hook_output_persisted` + `pre_tool_hook_deferred` | ch19 후크 |
| `memory_toggled` + `extract_memories_skipped_no_prose` | ch12 토큰 예산 |
| `rate_limit_lever_hint` | ch06 신속한 행동 조향 |
| `bridge_client_presence_enabled` | ch22 스킬 시스템 |
| +8/-3 환경 변수 | 부록 B |

</div>

### <a href="#v2191-new-features-in-detail" class="header">v2.1.91 새로운 기능 세부정보</a>

다음 세 가지 기능은 v2.1.88 소스 코드에는 **전혀 존재하지 않았으며** v2.1.91에 새로 추가되었습니다. 분석은 v2.1.91 번들 리버스 엔지니어링을 기반으로 합니다.

#### <a href="#1-powerup-lessons--interactive-feature-tutorial-system"
class="header">1. 파워업 레슨 — 대화형 기능 튜토리얼 시스템</a>

**이벤트**: `tengu_powerup_lesson_opened`, `tengu_powerup_lesson_completed`

**v2.1.88 상태**: 존재하지 않습니다. `restored-src/src/`에는 전원 켜기 또는 수업 관련 코드가 없습니다.

**v2.1.91 리버스 엔지니어링 결과**:

Powerup Lessons는 사용자에게 Claude Code의 핵심 기능을 사용하는 방법을 가르치는 10개의 코스 모듈이 포함된 내장형 대화형 튜토리얼 시스템입니다. 번들에서 추출된 전체 과정 레지스트리:

<div class="table-wrapper">

| 코스 ID | 제목 | 관련 기능 |
|----|----|----|
| `at-mentions` | 코드베이스와 대화하세요 | @ 파일 참조, 줄 번호 참조 |
| `modes` | 모드로 조종 | Shift+Tab 모드 전환, 계획, 자동 |
| `undo` | 무엇이든 실행 취소 | `/rewind`, Esc-Esc |
| `background` | 백그라운드에서 실행 | 백그라운드 작업, `/tasks` |
| `memory` | 클로드에게 규칙을 가르쳐주세요 | CLAUDE.md, `/memory`, `/init` |
| `mcp` | 도구를 사용하여 확장 | MCP 서버, `/mcp` |
| `automate` | 워크플로 자동화 | 스킬, 후크, `/hooks` |
| `subagents` | 자신을 곱하세요 | 하위 에이전트, `/agents`, `--worktree` |
| `cross-device` | 어디서나 코드 작성 | `/remote-control`, `/teleport` |
| `model-dial` | 모델에게 전화 걸기 | `/model`, `/effort`, `/fast` |

</div>

**기술적 구현**(번들 리버스 엔지니어링에서):

``` javascript
// Course opened event
logEvent("tengu_powerup_lesson_opened", {
  lesson_id: lesson.id,           // Course ID
  was_already_unlocked: unlocked.has(lesson.id),  // Already unlocked?
  unlocked_count: unlocked.size   // Total unlocked count
})

// Course completed event
logEvent("tengu_powerup_lesson_completed", {
  lesson_id: id,
  unlocked_count: newUnlocked.size,
  all_unlocked: newUnlocked.size === lessons.length  // All completed?
})
```

잠금 해제 상태는 `powerupsUnlocked`를 통해 사용자 구성에 유지됩니다. 각 과정에는 제목, 태그라인, 서식 있는 텍스트 콘텐츠(터미널 애니메이션 데모 포함)가 포함되어 있으며 UI는 완료 상태에 대한 확인/원 마커를 사용하여 모든 과정이 완료되면 "이스터 에그" 애니메이션을 트리거합니다.

**도서 관련성**: Powerup Lessons의 10개 코스 모듈은 권한 모드(ch16-17)부터 하위 에이전트(ch20), MCP(ch22)까지 이 책의 2부부터 6부까지의 거의 모든 핵심 주제를 다룹니다. 이는 "사용자가 숙달해야 하는 기능"에 대한 Anthropic의 공식 우선순위를 나타내며 이 책의 "당신이 할 수 있는 것" 섹션에 대한 참조 역할을 할 수 있습니다.

------------------------------------------------------------------------

#### <a href="#2-write-append-mode--file-append-writing" class="header">2. 쓰기 추가 모드 - 파일 추가 쓰기</a>

**이벤트**: `tengu_write_append_used`

**v2.1.88 상태**: 존재하지 않습니다. v2.1.88의 쓰기 도구는 덮어쓰기(완전 교체) 모드만 지원합니다.

**v2.1.91 리버스 엔지니어링 결과**:

쓰기 도구의 inputSchema는 새로운 `mode` 매개변수를 얻었습니다.

``` typescript
// v2.1.91 bundle reverse engineering
inputSchema: {
  file_path: string,
  content: string,
  mode: "overwrite" | "append"  // New in v2.1.91
}
```

`mode` 매개변수 설명(번들에서 추출):

> 쓰기 모드. 'overwrite'(기본값)는 파일을 대체합니다. 전체 콘텐츠를 다시 작성하는 대신 기존 파일 끝에 콘텐츠를 추가하려면 '추가'를 사용하세요. 로그, 출력 누적 또는 목록에 항목 추가.

**기능 게이트**: 추가 모드는 GrowthBook 플래그 `tengu_maple_forge_w8k`에 의해 제어됩니다. 플래그가 꺼져 있으면 `mode` 필드가 스키마에서 `.omit()`'되어 모델에 표시되지 않습니다.

``` javascript
// v2.1.91 bundle reverse engineering
function getWriteSchema() {
  return getFeatureValue("tengu_maple_forge_w8k", false)
    ? fullSchema()           // Includes mode parameter
    : fullSchema().omit({ mode: true })  // Hides mode parameter
}
```

**도서 관련성**: ch02(도구 시스템 개요) 및 ch08(도구 프롬프트)에 영향을 미칩니다. v2.1.88에서는 쓰기 도구의 프롬프트에 "이 도구는 기존 파일을 덮어씁니다"라고 명시되어 있습니다. v2.1.91의 추가 모드는 이 제약 조건을 변경하며 이제 모델은 덮어쓰기 대신 추가하도록 선택할 수 있습니다.

------------------------------------------------------------------------

#### <a href="#3-message-rating--message-rating-feedback" class="header">3. 메시지 등급 - 메시지 등급 피드백</a>

**이벤트**: `tengu_message_rated`

**v2.1.88 상태**: 존재하지 않습니다. v2.1.88에는 `tengu_feedback_survey_*` 시리즈 이벤트(세션 수준 피드백)가 있었지만 메시지 수준 평가는 없었습니다.

**v2.1.91 리버스 엔지니어링 결과**:

메시지 등급은 사용자가 개별 Claude 응답을 평가할 수 있는 메시지 수준 사용자 피드백 메커니즘입니다. 번들 리버스 엔지니어링에서 추출된 구현:

``` javascript
// v2.1.91 bundle reverse engineering
function rateMessage(messageUuid, sentiment) {
  const wasAlreadyRated = ratings.get(messageUuid) === sentiment
  // Clicking the same rating again → clear (toggle behavior)
  if (wasAlreadyRated) {
    ratings.delete(messageUuid)
  } else {
    ratings.set(messageUuid, sentiment)
  }

  logEvent("tengu_message_rated", {
    message_uuid: messageUuid,  // Message unique ID
    sentiment: sentiment,       // Rating direction (e.g., thumbs_up/thumbs_down)
    cleared: wasAlreadyRated    // Was the rating cleared?
  })

  // Show thank-you notification after rating
  if (!wasAlreadyRated) {
    addNotification({
      key: "message-rated",
      text: "thanks for improving claude!",
      color: "success",
      priority: "immediate"
    })
  }
}
```

**UI 메커니즘**:

- 등급 기능은 React Context(`MessageRatingProvider`)를 통해 메시지 목록에 삽입됩니다.
- 등급 상태는 메모리에 `Map<messageUuid, sentiment>`로 저장됩니다.
- 토글 지원 - 동일한 등급을 다시 클릭하면 삭제됩니다.
- 평가 후 "claude를 개선해 주셔서 감사합니다!"라는 녹색 알림이 표시됩니다. 나타납니다

**도서 관련성**: ch29(관측성 엔지니어링)과 관련됩니다. v2.1.88의 피드백 시스템은 세션 수준(`tengu_feedback_survey_*`)이었습니다. v2.1.91에는 메시지 수준 평가가 추가되어 "전체 세션이 좋았습니까?"에서 "이 특정 응답이 좋았습니까?"로 피드백 세분성을 개선합니다. 이는 Anthropic에 RLHF(인간 피드백을 통한 강화 학습)에 대한 보다 세분화된 훈련 신호를 제공합니다.

------------------------------------------------------------------------

### <a href="#experimental-codename-events" class="header">실험적인 코드명 이벤트</a>

무작위 코드명이 포함된 다음 이벤트는 목적이 공개되지 않은 A/B 테스트입니다.

<div class="table-wrapper">

| 이벤트 | 메모 |
|----|----|
| `tengu_garnet_plover` | 알 수 없는 실험 |
| `tengu_gleaming_fair` | 알 수 없는 실험 |
| `tengu_gypsum_kite` | 알 수 없는 실험 |
| `tengu_slate_finch` | 알 수 없는 실험 |
| `tengu_slate_reef` | 알 수 없는 실험 |
| `tengu_willow_prism` | 알 수 없는 실험 |
| `tengu_maple_forge_w` | 쓰기 추가 모드의 기능 게이트 `tengu_maple_forge_w8k` 관련 |
| `tengu_lean_sub_pf` | 하위 에이전트 린 스키마와 관련이 있을 수 있음 |
| `tengu_sub_nomdrep_q` | 하위 에이전트 행동과 관련이 있을 수 있음 |
| `tengu_noreread_q` | `tengu_file_read_reread` 파일 다시 읽기 건너뛰기와 관련이 있을 수 있음 |

</div>

------------------------------------------------------------------------

## <a href="#v2191---v2192-incremental-changes" class="header">v2.1.91 -&gt; v2.1.92(증분 변경)</a>

> v2.1.91과 v2.1.92 번들 사이에서 추출된 신호 차이를 기반으로 합니다. `docs/version-diffs/v2.1.88-vs-v2.1.92.md`에서 전체 비교 보고서를 볼 수 있습니다.

### <a href="#overview" class="header">개요</a>

<div class="table-wrapper">

| 미터법 | v2.1.91 | v2.1.92 | 델타 |
|-----------------------|---------|-------------|--------------------|
| cli.js 크기 | 12.5MB | 12.6MB | +59KB |
| 텐구 이벤트 | 860 | 857 | +19 / -21 (순 -3) |
| 환경변수 | 183 | 186 | +3 |
| seccomp 바이너리 | 없음 | arm64 + x64 | **새로운** |

</div>

### <a href="#key-additions" class="header">주요 추가사항</a>

<div class="table-wrapper">

| 서브시스템 | 새로운 신호 | 영향을 받는 챕터 | 분석 |
|----|----|----|----|
| **도구** | `advisor_command`, `advisor_dialog_shown` + 10개의 Advisor\_\* 식별자 | ch04 | 완전히 새로운 AdvisorTool — 자체 모델 호출 체인을 갖춘 최초의 비실행 도구 |
| **도구** | `tool_result_dedup` | ch04 | 도구 결과 중복 제거는 v2.1.91의 `file_read_reread`와 함께 입력/출력 양면 중복 제거를 형성합니다. |
| **보안** | `vendor/seccomp/{arm64,x64}/apply-seccomp` | ch16 | v2.1.91에서 제거된 tree-sitter 애플리케이션 수준 분석을 대체하는 시스템 수준 seccomp 샌드박스 |
| **훅** | `stop_hook_added`, `stop_hook_command`, `stop_hook_removed` | ch18 | Stop Hook 런타임 동적 추가/제거 — Hook 시스템이 처음으로 런타임 관리를 지원합니다. |
| **인증** | `bedrock_setup_started/complete/cancelled`, `oauth_bedrock_wizard_launched` | ch05 | AWS Bedrock 안내 설정 마법사 |
| **인증** | `oauth_platform_docs_opened` | ch05 | OAuth 흐름 중에 플랫폼 문서 열기 |
| **도구** | `bash_rerun_used` | ch04 | Bash 명령 재실행 기능 |
| **모델** | `rate_limit_options_menu_select_team` | — | 속도 제한 중 팀 옵션 |

</div>

### <a href="#key-removals" class="header">키 제거</a>

<div class="table-wrapper">

| 제거된 신호 | 분석 |
|----|----|
| `session_tagged`, `tag_command_*`(총 5개) | 세션 태깅 시스템이 완전히 제거되었습니다. |
| `sm_compact` | 레거시 압축 이벤트 정리(v2.1.91에는 이미 대체품으로 cold_compact가 도입됨) |
| `skill_improvement_survey` | 실력향상 설문조사 종료 |
| `pid_based_version_locking` | PID 기반 버전 잠금 메커니즘이 제거되었습니다. |
| `compact_streaming_retry` | 압축 스트리밍 재시도가 정리되었습니다. |
| `ultraplan_model` | Ultraplan 모델 이벤트 리팩터링 |
| 6개의 무작위 코드명 실험 이벤트 | 기존 A/B 테스트 종료(cobalt_frost, Copper_bridge 등) |

</div>

### <a href="#new-environment-variables" class="header">새로운 환경 변수</a>

<div class="table-wrapper">

| 변하기 쉬운 | 목적 |
|----|----|
| `CLAUDE_CODE_EXECPATH` | 실행 파일 경로 |
| `CLAUDE_CODE_SIMULATE_PROXY_USAGE` | 프록시 사용 시뮬레이션(테스트용) |
| `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK` | 빠른 모드 조직 수준 확인 건너뛰기 |

</div>

### <a href="#design-trends" class="header">디자인 트렌드</a>

v2.1.91 -\> v2.1.92 증분은 작지만 방향이 명확합니다.

1. **보안 전략은 애플리케이션 계층에서 시스템 계층으로 내려갑니다**(tree-sitter -\> seccomp)
2. **도구 시스템은 순수 실행에서 자문으로 확장**(AdvisorTool)
3. **구성 관리는 순전히 정적에서 런타임 변경 가능으로 이동합니다**(중지 후크 동적 관리)
4. **엔터프라이즈 온보딩 장벽이 계속 낮아지고 있습니다**(Bedrock 마법사)

------------------------------------------------------------------------

*차이점 데이터를 생성하려면 `scripts/cc-version-diff.sh`를 사용하세요. `docs/anchor-points.md`는 하위 시스템 앵커 포인트 위치를 제공합니다*

------------------------------------------------------------------------

## <a href="#v2192---v21100" class="header">v2.1.92 -&gt; v2.1.100</a>

**개요**: cli.js +870KB (+6.9%) \| 텐구 이벤트 +45/-21 (net +24) \| 환경 변수 +8/-2 \| 새로운 오디오 캡처 공급업체

### <a href="#high-impact-changes-1" class="header">큰 영향을 미치는 변경 사항</a>

<div class="table-wrapper">

| 변화 | 영향을 받는 챕터 | 세부 |
|----|----|----|
| 드림시스템 성숙 | ch24 메모리 시스템 | kairos_dream 크론 스케줄링 + auto_dream_skipped 관측 가능성 + dream_invoked 수동 트리거 추적 |
| Bedrock/Vertex 전체 마법사 | ch06b API 통신 | 설정, 조사, 업그레이드 전체 수명주기를 다루는 18개 이벤트 |
| 도구 결과 중복 제거 | ch10 파일 상태 보존 | 컨텍스트를 저장하는 짧은 ID 참조를 사용한 도구 결과 중복 제거 |
| 브리지 REPL 주요 정리 | ch06b API 통신 | 16개 bridge_repl\_\* 이벤트 제거(사소한 잔여 참조 남아 있음), 통신 메커니즘 재구성 |
| toolStats 통계 필드 | ch24 메모리 시스템 | sdk-tools.d.ts는 7차원 도구 사용 통계를 추가합니다. |

</div>

### <a href="#medium-impact-changes-1" class="header">중간 영향 변경</a>

<div class="table-wrapper">

| 변화 | 영향을 받는 챕터 | 세부 |
|----|----|----|
| 고문 도구 | ch21 노력/생각 | 서버 측 강력한 모델 검토 도구, 기능 게이트 `advisor-tool-2026-03-01` |
| 자동 수정 PR | ch20c 울트라플랜 | 울트라플랜/울트라리뷰와 함께 원격 세션 자동 수정 PR |
| 팀 온보딩 | ch20b 팀 | 사용 보고서 생성 + 온보딩 검색 |
| 맨틀 인증 백엔드 | ch06b, 부록 G | 다섯 번째 API 인증 채널 |
| 콜드 컴팩트 강화 | ch09 자동 압축 | 기능 플래그 기반 + MAX_CONTEXT_TOKENS 재정의 |

</div>

### <a href="#low-impact-changes-1" class="header">영향이 적은 변경 사항</a>

<div class="table-wrapper">

| 변화 | 영향을 받는 챕터 |
|----|----|
| `hook_prompt_transcript_truncated` + stop_hook 수명주기 | ch18 후크 |
| Perforce VCS 지원(`CLAUDE_CODE_PERFORCE_MODE`) | ch04 도구 |
| 오디오 캡처 공급업체 바이너리(6개 플랫폼) | 잠재적인 새로운 기능 |
| `image_resize` — 자동 이미지 크기 조정 | ch04 도구 |
| `bash_allowlist_strip_all` — bash 허용 목록 작업 | ch16 권한 |
| +8/-2 환경 변수 | 부록 B |
| 12개 이상의 새로운 실험 코드명 이벤트 | ch23 기능 플래그 |

</div>

### <a href="#v21100-new-features-in-detail" class="header">v2.1.100 새로운 기능 세부정보</a>

다음 기능은 v2.1.92에는 **존재하지 않았으며** 또는 초보적인 형태만 있었으며 v2.1.92→v2.1.100에서 점진적으로 추가되었습니다.

#### <a href="#1-kairos-dream--background-scheduled-memory-consolidation"
class="header">1. Kairos Dream — 백그라운드 예약 메모리 통합</a>

**이벤트**: `tengu_kairos_dream`

**v2.1.92 상태**: v2.1.92에는 이미 `auto_dream` 및 수동 `/dream` 트리거가 있지만 백그라운드 크론 예약은 없습니다.

**v2.1.100 추가**:

Kairos Dream은 Dream 시스템의 세 번째 트리거 모드입니다. 사용자가 새 세션을 시작할 때까지 기다리지 않고 백그라운드에서 cron 스케줄링을 통해 자동으로 메모리 통합을 실행합니다. 번들에서 추출된 Cron 표현식 생성:

``` javascript
// v2.1.100 bundle reverse engineering
function P_A() {
  let q = Math.floor(Math.random() * 360);
  return `${q % 60} ${Math.floor(q / 60)} * * *`;
  // Random minute+hour offset, avoids multi-user simultaneous triggers
}
```

`auto_dream_skipped` 이벤트의 `reason` 필드("세션"/"잠금")와 결합하여 Kairos Dream은 완전한 백그라운드 메모리 통합 수명주기를 구현합니다.

**도서 관련성**: Dream 시스템 분석으로 업데이트된 ch24(3계층 트리거 매트릭스); ch29 관찰 가능성 장에서는 관찰 가능성 설계 사례 연구로 `auto_dream_skipped` 건너뛰기 이유 분포를 참조할 수 있습니다.

------------------------------------------------------------------------

#### <a href="#2-bedrockvertex-model-upgrade-wizard" class="header">2. 기반암/정점 모델 업그레이드 마법사</a>

**이벤트**: 18개 이벤트(9개 기반암 + 9개 정점), 대칭 구조

**v2.1.92 상태**: v2.1.92에는 Bedrock의 `setup_started/complete/cancelled`(3개 이벤트)만 있었습니다.

**v2.1.100 추가**:

완벽한 모델 ​​업그레이드 감지 및 자동 전환 메커니즘. 디자인 하이라이트:

1. **고정 해제된 모델 감지**: 사용자 구성을 검사하여 환경 변수를 통해 명시적으로 고정되지 않은 모델 계층을 찾습니다.
2. **접근성 조사**: `probeBedrockModel` / `probeVertexModel`는 사용자 계정에서 새 모델을 사용할 수 있는지 확인합니다.
3. **사용자 확인**: 업그레이드는 자동으로 실행되지 않습니다. 사용자 동의/거부 필요
4. **지속적인 거부**: 거부된 업그레이드는 사용자 설정에 기록되어 반복적인 메시지가 표시되지 않습니다.
5. **기본 대체**: 기본 모델에 액세스할 수 없는 경우 동일한 계층 대체 모델로 자동 대체

Vertex 마법사(`vertex_setup_started` 등)는 v2.1.100의 새로운 기능입니다. v2.1.92에는 대화형 Vertex 설정이 없습니다.

------------------------------------------------------------------------

#### <a href="#3-autofix-pr--remote-auto-fix" class="header">3. Autofix PR - 원격 자동 수정</a>

**이벤트**: `tengu_autofix_pr_started`, `tengu_autofix_pr_result`

**v2.1.92 상태**: 존재하지 않습니다. v2.1.92에는 ultraplan과 ultrareview가 있었지만 autofix-pr은 없었습니다.

**v2.1.100 추가**:

Autofix PR은 `XAY` 원격 작업 유형 레지스트리에서 `remote-agent`, `ultraplan` 및 `ultrareview`와 함께 나열된 네 번째 원격 에이전트 작업 유형입니다. 번들에서 추출된 워크플로우:

``` javascript
// v2.1.100 bundle reverse engineering
// Remote task type registry
XAY = ["remote-agent", "ultraplan", "ultrareview", "autofix-pr", "background-pr"];

// Autofix PR launch
d("tengu_autofix_pr_started", {});
let b = await kt({
  initialMessage: h,
  source: "autofix_pr",
  branchName: P,
  reuseOutcomeBranch: P,
  title: `Autofix PR: ${k}/${R}#${v} (${P})`
});
```

Autofix PR은 지정된 Pull Request를 모니터링하고 문제(CI 실패, 코드 검토 피드백)를 자동으로 수정하는 원격 Claude Code 세션을 생성합니다. Ultraplan(계획) 및 Ultrareview(검토)와 달리 Autofix PR은 **수정 실행**에 중점을 둡니다.

참고 `background-pr`도 작업 유형 목록에 나타나며 다른 백그라운드 PR 처리 모드를 제안합니다.

------------------------------------------------------------------------

#### <a href="#4-team-onboarding--team-usage-report" class="header">4. 팀 온보딩 - 팀 사용 보고서</a>

**이벤트**: `tengu_team_onboarding_invoked`, `tengu_team_onboarding_generated`, `tengu_team_onboarding_discovery_shown`

**v2.1.92 상태**: 존재하지 않습니다.

**v2.1.100 추가**:

사용자 사용 데이터(세션 수, 슬래시 명령 수, MCP 서버 수)를 수집하고 템플릿에서 안내 문서를 생성하는 팀 온보딩 보고서 생성기입니다. 번들에서 추출된 주요 매개변수:

- `windowDays`: 분석 기간(1~365일)
- `sessionCount`, `slashCommandCount`, `mcpServerCount`: 사용 통계 차원
- `GUIDE_TEMPLATE`, `USAGE_DATA`: 보고서 템플릿 변수

`cedar_inlet` 실험 이벤트는 팀 온보딩 검색 디스플레이(`discovery_shown`)를 제어하며 이는 A/B 테스트된 기능임을 나타냅니다.

------------------------------------------------------------------------

### <a href="#experiment-codename-events" class="header">실험 코드명 이벤트</a>

무작위 코드명이 포함된 다음 이벤트는 목적이 공개되지 않은 A/B 테스트입니다.

<div class="table-wrapper">

| 이벤트 | 상태 | 메모 |
|----|----|----|
| `tengu_amber_sentinel` | v2.1.100의 새로운 기능 | — |
| `tengu_basalt_kite` | v2.1.100의 새로운 기능 | — |
| `tengu_billiard_aviary` | v2.1.100의 새로운 기능 | — |
| `tengu_cedar_inlet` | v2.1.100의 새로운 기능 | 팀 온보딩 검색 관련 |
| `tengu_coral_beacon` | v2.1.100의 새로운 기능 | — |
| `tengu_flint_harbor` / `_prompt` / `_heron` | v2.1.100의 새로운 기능 | 관련 이벤트 3개 |
| `tengu_garnet_loom` | v2.1.100의 새로운 기능 | — |
| `tengu_pyrite_wren` | v2.1.100의 새로운 기능 | — |
| `tengu_shale_finch` | v2.1.100의 새로운 기능 | — |

</div>

v2.1.92에 존재하지만 v2.1.100에서 제거된 실험: `amber_lantern`, `editafterwrite_qpl`, `lean_sub_pf`, `maple_forge_w`, `relpath_gh`.

------------------------------------------------------------------------

### <a href="#design-trends-1" class="header">디자인 트렌드</a>

v2.1.92→v2.1.100 진화 방향:

1. **패시브에서 액티브로의 메모리 시스템** (auto_dream → kairos_dream 예약 실행 + 관찰 가능한 건너뛰기 이유)
2. **구성에서 마법사까지의 클라우드 플랫폼**(수동 환경 변수 → 대화형 설정 마법사 + 자동 모델 업그레이드 감지)
3. **IDE 브리지 아키텍처 재구성됨**(bridge_repl이 크게 제거되고 16개 이벤트가 지워짐 - 새로운 통신 메커니즘으로 전환 중)
4. **원격 상담원 제품군 확장**(ultraplan/ultrareview → + autofix-pr + background-pr)
5. **컨텍스트 최적화 개선**(tool_result_dedup으로 중복 감소 + MAX_CONTEXT_TOKENS 사용자 제어 가능)

------------------------------------------------------------------------

*차이점 데이터를 생성하려면 `scripts/cc-version-diff.sh`를 사용하세요. `docs/anchor-points.md`는 하위 시스템 앵커 포인트 위치를 제공합니다*
