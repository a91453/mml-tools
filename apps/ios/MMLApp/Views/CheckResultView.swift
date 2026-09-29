import MMLCore
import MMLProjects
import SwiftUI

/// The stored technical check, shown as the core stated it. Nothing here
/// re-judges the MML: verdicts, codes and messages are the core's own.
struct CheckResultView: View {
    let record: TechnicalCheckRecord?
    let freshness: CheckFreshness?

    var body: some View {
        if let record {
            VStack(alignment: .leading, spacing: 12) {
                FreshnessBanner(freshness: freshness)
                switch record.outcome {
                case let .report(report):
                    ReportView(report: report, record: record)
                case let .refused(refusal):
                    Label {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("核心未判定：\(refusal.code)").font(.headline)
                            Text(refusal.message).font(.callout)
                        }
                    } icon: {
                        Image(systemName: "questionmark.diamond.fill").foregroundStyle(.orange)
                    }
                }
            }
            .padding(.vertical, 4)
        } else {
            Text("尚未檢查。填好拍號圖與 MML 後按「檢查」。").foregroundStyle(.secondary)
        }
    }
}

private struct FreshnessBanner: View {
    let freshness: CheckFreshness?

    var body: some View {
        switch freshness {
        case .current?:
            Label("與目前內容及本機核心一致", systemImage: "checkmark.circle").font(.caption).foregroundStyle(.green)
        case let .stale(reasons)?:
            Label {
                Text("結果已過時：" + StaleReason.allCases.filter(reasons.contains).map(\.text).joined(separator: "、") + "。請重新檢查。")
            } icon: {
                Image(systemName: "clock.badge.exclamationmark")
            }
            .font(.caption)
            .foregroundStyle(.orange)
        case nil:
            Label("本機核心未載入，無法確認結果是否仍適用", systemImage: "questionmark.circle").font(.caption).foregroundStyle(.secondary)
        }
    }
}

private extension StaleReason {
    var text: String {
        switch self {
        case .inputChanged: return "MML 或時間結構已修改"
        case .canonicalChanged: return "目前核心使用不同的 Published Canonical"
        case .engineChanged: return "目前核心是不同的建置"
        }
    }
}

private struct ReportView: View {
    let report: TechnicalReport
    let record: TechnicalCheckRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verdict).font(.headline)
                    Text("\(record.engine.canonicalVersion ?? "?") · \(report.profile ?? "?")")
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                    Text(record.checkedAt, format: .dateTime.year().month().day().hour().minute().second())
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: report.technicalOk == true ? "checkmark.seal.fill" : "xmark.octagon.fill")
                    .foregroundStyle(report.technicalOk == true ? .green : .red)
            }

            DiagnosticList(title: "錯誤", count: report.errorCount, diagnostics: report.errors, tint: .red)
            DiagnosticList(title: "提醒", count: report.warnings.count, diagnostics: report.warnings, tint: .orange)

            if !report.tracks.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("六軌").font(.subheadline.bold())
                    ForEach(report.tracks, id: \.role) { track in
                        HStack {
                            Text(track.role).font(.caption.monospaced()).frame(width: 64, alignment: .leading)
                            if track.empty {
                                Text("空軌").font(.caption).foregroundStyle(.secondary)
                            } else {
                                Text("\(track.characters)/\(track.characterLimit) 字 · \(track.totalBeats) 拍 · \(track.noteEvents) 音")
                                    .font(.caption)
                                    .foregroundStyle(track.characters > track.characterLimit ? .red : .primary)
                            }
                        }
                    }
                }
            }

            VStack(alignment: .leading, spacing: 2) {
                if let beats = report.totalBeats { Text("總拍長 \(beats) 拍 · \(report.barCount) 小節").font(.caption) }
                if let seconds = report.estimatedSeconds { Text("估計長度 \(seconds, format: .number.precision(.fractionLength(1))) 秒").font(.caption) }
                if !report.tempoMap.isEmpty { Text("Tempo：" + report.tempoMap.map { "第\($0.beat)拍 T\($0.bpm)" }.joined(separator: "、")).font(.caption) }
                if !report.meterMap.isEmpty { Text("拍號：" + report.meterMap.map { "第\($0.beat)拍 \($0.numerator)/\($0.denominator)" }.joined(separator: "、")).font(.caption) }
            }

            if !report.gates.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("各驗收面向（互相獨立）").font(.subheadline.bold())
                    ForEach(report.gates.keys.sorted(), id: \.self) { gate in
                        HStack {
                            Text(gate).font(.caption2.monospaced())
                            Spacer()
                            Text(report.gates[gate] ?? "").font(.caption2.monospaced().bold())
                        }
                    }
                }
            }

            if let notice = report.evidenceNotice {
                Text(notice).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private var verdict: String {
        switch report.technicalOk {
        case true?: return "Strict Mobile 技術檢查 PASS"
        case false?: return "Strict Mobile 技術檢查 FAIL"
        case nil: return "非 Published Canonical 判定"
        }
    }
}

private struct DiagnosticList: View {
    let title: String
    let count: Int
    let diagnostics: [Diagnostic]
    let tint: Color

    var body: some View {
        if count > 0 || !diagnostics.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("\(title)（\(count)）").font(.subheadline.bold()).foregroundStyle(tint)
                ForEach(Array(diagnostics.enumerated()), id: \.offset) { _, diagnostic in
                    VStack(alignment: .leading, spacing: 2) {
                        let location = [diagnostic.role, diagnostic.position.map { "第\($0)字" }, diagnostic.code].compactMap { $0 }
                        if !location.isEmpty {
                            Text(location.joined(separator: " · ")).font(.caption2.monospaced()).foregroundStyle(.secondary)
                        }
                        Text(diagnostic.message).font(.caption)
                    }
                }
                if count > diagnostics.count {
                    Text("另有 \(count - diagnostics.count) 項未列出").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }
}
