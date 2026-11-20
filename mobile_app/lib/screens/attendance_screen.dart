import 'package:flutter/material.dart';

import '../app_scope.dart';
import '../models/attendance.dart';
import '../services/api_service.dart';
import '../widgets/demo_banner.dart';
import '../widgets/state_views.dart';

/// Attendance from GET /attendance/me.
class AttendanceScreen extends StatefulWidget {
  const AttendanceScreen({super.key});

  @override
  State<AttendanceScreen> createState() => _AttendanceScreenState();
}

class _AttendanceScreenState extends State<AttendanceScreen> {
  AttendanceReport? _report;
  String? _error;
  bool _loading = false;
  bool _demo = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    final scope = AppScope.read(context);
    try {
      final report = await scope.api.getAttendance(demo: _demo);
      if (mounted) setState(() => _report = report);
    } on ApiException catch (e) {
      if (e.isUnauthorized) {
        await scope.auth.logout();
        return;
      }
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _setDemo(bool demo) {
    setState(() {
      _demo = demo;
      _report = null;
    });
    _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Attendance'),
        actions: [
          if (_demo)
            IconButton(
              tooltip: 'Exit demo',
              onPressed: _loading ? null : () => _setDemo(false),
              icon: const Icon(Icons.close_rounded),
            )
          else if (_report?.linked ?? false)
            IconButton(
              tooltip: 'View Demo Data',
              onPressed: _loading ? null : () => _setDemo(true),
              icon: const Icon(Icons.science_outlined),
            ),
          if (_report?.isDemo ?? false)
            const Padding(
              padding: EdgeInsets.only(right: 4),
              child: Center(child: DemoChip()),
            ),
          IconButton(
            tooltip: 'Refresh',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    final report = _report;

    if (report == null) {
      if (_error != null) {
        return MessageView(
          icon: Icons.cloud_off_rounded,
          title: "Couldn't load attendance",
          message: _error!,
          actionLabel: 'Try again',
          onAction: _load,
          isError: true,
        );
      }
      return const LoadingView(message: 'Loading attendance...');
    }

    if (!report.linked && !_demo) {
      return MessageView(
        icon: Icons.link_off_rounded,
        title: 'Account not linked',
        message: report.message ??
            'Your account is not linked to a student record.',
        actionLabel: 'View demo data',
        actionIcon: Icons.science_outlined,
        onAction: () => _setDemo(true),
      );
    }

    if (report.records.isEmpty) {
      return RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            const SizedBox(height: 80),
            MessageView(
              icon: Icons.fact_check_outlined,
              title: 'No attendance yet',
              message: report.message ?? 'No attendance records yet.',
              actionLabel: !_demo ? 'View demo data' : null,
              actionIcon: Icons.science_outlined,
              onAction: !_demo ? () => _setDemo(true) : null,
            ),
          ],
        ),
      );
    }

    final summary = report.summary;

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
        children: [
          if (report.isDemo) ...[
            DemoBanner(
              message: report.message ??
                  'Sample records for demonstration, not official attendance.',
              onExit: _demo ? () => _setDemo(false) : null,
            ),
            const SizedBox(height: 16),
          ],
          _OverviewCard(summary: summary, studentName: report.student?.name),
          if (summary.lowAttendanceSubjects.isNotEmpty) ...[
            const SizedBox(height: 16),
            _LowAttendanceWarning(summary: summary),
          ],
          const SizedBox(height: 24),
          Text(
            'Subject-wise attendance',
            style: Theme.of(context)
                .textTheme
                .titleMedium
                ?.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 12),
          for (final record in report.records) ...[
            _SubjectCard(record: record, threshold: summary.threshold),
            const SizedBox(height: 12),
          ],
          if (!_demo && report.linked) ...[
            const SizedBox(height: 8),
            Center(
              child: OutlinedButton.icon(
                icon: const Icon(Icons.science_outlined, size: 18),
                label: const Text('Preview Demo Data'),
                onPressed: () => _setDemo(true),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

Color attendanceColor(BuildContext context, double percentage, double threshold) {
  if (percentage >= threshold) return Colors.green.shade600;
  if (percentage >= threshold - 10) return Colors.orange.shade700;
  return Theme.of(context).colorScheme.error;
}

class _OverviewCard extends StatelessWidget {
  const _OverviewCard({required this.summary, this.studentName});

  final AttendanceSummary summary;
  final String? studentName;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final color = attendanceColor(context, summary.percentage, summary.threshold);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          children: [
            Row(
              children: [
                SizedBox(
                  width: 112,
                  height: 112,
                  child: Stack(
                    fit: StackFit.expand,
                    children: [
                      CircularProgressIndicator(
                        value: (summary.percentage / 100).clamp(0, 1),
                        strokeWidth: 10,
                        strokeCap: StrokeCap.round,
                        color: color,
                        backgroundColor: color.withValues(alpha: 0.15),
                      ),
                      Center(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              '${summary.percentage.toStringAsFixed(1)}%',
                              key: const Key('overall_percentage'),
                              style: theme.textTheme.titleLarge?.copyWith(
                                fontWeight: FontWeight.w800,
                                color: color,
                              ),
                            ),
                            Text('Overall', style: theme.textTheme.bodySmall),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 20),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Overall attendance',
                        style: theme.textTheme.titleMedium
                            ?.copyWith(fontWeight: FontWeight.w700),
                      ),
                      if (studentName != null && studentName!.isNotEmpty) ...[
                        const SizedBox(height: 2),
                        Text(
                          studentName!,
                          style: theme.textTheme.bodyMedium
                              ?.copyWith(color: scheme.onSurfaceVariant),
                        ),
                      ],
                      const SizedBox(height: 8),
                      Text(
                        '${summary.subjectCount} subjects · minimum '
                        '${summary.threshold.toStringAsFixed(0)}% required',
                        style: theme.textTheme.bodySmall
                            ?.copyWith(color: scheme.onSurfaceVariant),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            Row(
              children: [
                _Stat(
                  label: 'Total',
                  value: summary.totalClasses,
                  color: scheme.primary,
                  icon: Icons.class_outlined,
                ),
                _Stat(
                  label: 'Present',
                  value: summary.presentClasses,
                  color: Colors.green.shade600,
                  icon: Icons.check_circle_outline_rounded,
                ),
                _Stat(
                  label: 'Absent',
                  value: summary.absentClasses,
                  color: scheme.error,
                  icon: Icons.cancel_outlined,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({
    required this.label,
    required this.value,
    required this.color,
    required this.icon,
  });

  final String label;
  final int value;
  final Color color;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Expanded(
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 4),
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          children: [
            Icon(icon, color: color, size: 20),
            const SizedBox(height: 4),
            Text(
              '$value',
              style: theme.textTheme.titleLarge
                  ?.copyWith(fontWeight: FontWeight.w800, color: color),
            ),
            Text(label, style: theme.textTheme.bodySmall),
          ],
        ),
      ),
    );
  }
}

class _LowAttendanceWarning extends StatelessWidget {
  const _LowAttendanceWarning({required this.summary});

  final AttendanceSummary summary;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final subjects = summary.lowAttendanceSubjects;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: scheme.errorContainer,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.warning_amber_rounded, color: scheme.onErrorContainer),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Low attendance',
                  style: theme.textTheme.titleSmall?.copyWith(
                    color: scheme.onErrorContainer,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  'Below ${summary.threshold.toStringAsFixed(0)}% in '
                  '${subjects.length} ${subjects.length == 1 ? 'subject' : 'subjects'}: '
                  '${subjects.join(', ')}.',
                  style: theme.textTheme.bodySmall
                      ?.copyWith(color: scheme.onErrorContainer),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SubjectCard extends StatelessWidget {
  const _SubjectCard({required this.record, required this.threshold});

  final AttendanceRecord record;
  final double threshold;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final color = attendanceColor(context, record.percentage, threshold);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        record.subjectName,
                        style: theme.textTheme.titleSmall
                            ?.copyWith(fontWeight: FontWeight.w700),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        record.subjectCode,
                        style: theme.textTheme.bodySmall
                            ?.copyWith(color: scheme.onSurfaceVariant),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                Text(
                  '${record.percentage.toStringAsFixed(1)}%',
                  style: theme.textTheme.titleMedium?.copyWith(
                    color: color,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: LinearProgressIndicator(
                value: (record.percentage / 100).clamp(0, 1),
                minHeight: 8,
                color: color,
                backgroundColor: color.withValues(alpha: 0.15),
              ),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: Text(
                    '${record.presentClasses}/${record.totalClasses} present · '
                    '${record.absentClasses} absent',
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: scheme.onSurfaceVariant),
                  ),
                ),
                if (record.lowAttendance)
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: scheme.errorContainer,
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(
                      'Below ${threshold.toStringAsFixed(0)}%',
                      style: TextStyle(
                        color: scheme.onErrorContainer,
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
