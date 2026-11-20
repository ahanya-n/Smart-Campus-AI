import 'package:flutter/material.dart';

import '../app_scope.dart';
import '../services/api_service.dart';
import '../widgets/demo_banner.dart';

class AcademicIntelligenceScreen extends StatefulWidget {
  const AcademicIntelligenceScreen({super.key});

  @override
  State<AcademicIntelligenceScreen> createState() =>
      _AcademicIntelligenceScreenState();
}

class _AcademicIntelligenceScreenState
    extends State<AcademicIntelligenceScreen> {
  static const _prompts = [
    'Analyze my academic performance.',
    'Which subjects need improvement?',
    'Create a 7-day study plan.',
    'How can I improve my attendance?',
    'Explain my academic risk report.',
    'Analyze my internal marks.',
    'What should I focus on before exams?',
  ];

  final _mentorController = TextEditingController();
  final _noteController = TextEditingController();
  Map<String, dynamic>? _data;
  Map<String, dynamic>? _selectedStudent;
  Map<String, dynamic>? _mentorResponse;
  String? _error;
  bool _loading = true;
  bool _working = false;

  bool get _isStudent => AppScope.read(context).auth.user?.isStudent == true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _mentorController.dispose();
    _noteController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final api = AppScope.read(context).api;
    try {
      final result = _isStudent
          ? await api.getMyAcademicReport()
          : await api.getAcademicOverview();
      if (mounted) setState(() => _data = result);
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _askMentor([String? prompt]) async {
    final message = (prompt ?? _mentorController.text).trim();
    if (message.isEmpty || _working) return;
    setState(() {
      _working = true;
      _error = null;
      _mentorResponse = null;
    });
    try {
      final result = await AppScope.read(context).api
          .askAcademicMentor(message);
      if (mounted) {
        setState(() {
          _mentorResponse = result;
          _mentorController.clear();
        });
      }
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<void> _openStudent(Map<String, dynamic> row) async {
    setState(() {
      _working = true;
      _error = null;
    });
    try {
      final student = row['student'] as Map<String, dynamic>? ?? {};
      final report = await AppScope.read(context).api
          .getAcademicStudentReport('${student['student_id'] ?? ''}');
      if (mounted) {
        setState(() {
          _selectedStudent = {
            ...report,
            'latest_intervention': row['latest_intervention'],
          };
        });
      }
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<void> _recordMentoringNote() async {
    final report = _selectedStudent;
    final note = _noteController.text.trim();
    final student = report?['student'] as Map<String, dynamic>?;
    if (student == null || note.isEmpty || _working) return;
    setState(() {
      _working = true;
      _error = null;
    });
    try {
      await AppScope.read(context).api.createAcademicIntervention(
        studentId: '${student['student_id']}',
        note: note,
      );
      _noteController.clear();
      await _load();
      if (!mounted) return;
      final row = _maps(_data?['students'])
          .where(
            (item) =>
                (item['student'] as Map<String, dynamic>?)?['student_id'] ==
                student['student_id'],
          )
          .toList();
      if (row.isNotEmpty) await _openStudent(row.first);
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  List<Map<String, dynamic>> _maps(dynamic value) {
    if (value is! List) return [];
    return value.whereType<Map<String, dynamic>>().toList();
  }

  String _value(dynamic value, {String fallback = 'Not available'}) =>
      value == null ? fallback : '$value';

  @override
  Widget build(BuildContext context) {
    final isStudent = _isStudent;
    return Scaffold(
      appBar: AppBar(
        title: Text(isStudent ? 'Academic Intelligence' : 'Class Intelligence'),
        actions: [
          IconButton(
            tooltip: 'Refresh academic records',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: _loading && _data == null
          ? const Center(child: CircularProgressIndicator())
          : _error != null && _data == null
          ? _ErrorState(message: _error!, onRetry: _load)
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                children: [
                  if (_data?['is_demo'] == true) ...[
                    const DemoBanner(
                      message:
                          'Synthetic academic records for demonstration, not official results.',
                    ),
                    const SizedBox(height: 12),
                  ],
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Text(
                        _error!,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ),
                  if (isStudent)
                    ..._buildStudentContent()
                  else
                    ..._buildStaffContent(),
                ],
              ),
            ),
    );
  }

  List<Widget> _buildStudentContent() {
    final linked = _data?['linked'] == true;
    if (!linked) {
      return [
        const _InfoCard(
          title: 'Student record not linked',
          message: 'Link your official student record to view personal academic insights. No other student data is used.',
          icon: Icons.link_off_rounded,
        ),
      ];
    }

    final report = _data!;
    final student = report['student'] as Map<String, dynamic>? ?? {};
    final attendance = report['attendance'] as Map<String, dynamic>? ?? {};
    final trend = report['attendance_trend'] as Map<String, dynamic>? ?? {};
    final marks = report['internal_marks'] as Map<String, dynamic>? ?? {};
    final subjects = _maps(report['subjects']);
    final reasons = report['risk_reasons'] as List? ?? [];
    final recommendations = report['recommendations'] as List? ?? [];
    final limitations = report['data_limitations'] as List? ?? [];
    final risk = _value(report['risk_level'], fallback: 'insufficient_data');
    final riskColor = risk == 'high'
        ? Colors.red
        : risk == 'medium'
        ? Colors.orange
        : risk == 'low'
        ? Colors.green
        : Theme.of(context).colorScheme.outline;

    return [
      Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                _value(student['name'], fallback: 'My academic report'),
                style: Theme.of(context).textTheme.titleLarge,
              ),
              Text(
                '${_value(student['department'])} · Semester ${_value(student['semester'])}',
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Chip(
                    label: Text(
                      risk == 'insufficient_data'
                          ? 'INSUFFICIENT DATA'
                          : '${risk.toUpperCase()} RISK',
                    ),
                    backgroundColor: riskColor.withValues(alpha: 0.15),
                    side: BorderSide(color: riskColor),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _value(report['classification_type'])
                          .replaceAll('_', ' '),
                    ),
                  ),
                ],
              ),
              Text(
                'Attendance: ${attendance['overall_percentage'] == null ? 'No official totals' : '${attendance['overall_percentage']}%'}',
              ),
              Text('Attendance trend: ${_value(trend['direction'])}'),
              Text(
                'Internal marks: ${marks['available'] == true ? '${marks['average_percentage']}% average' : 'Not available'}',
              ),
              const SizedBox(height: 8),
              const Text(
                'Why this status?',
                style: TextStyle(fontWeight: FontWeight.bold),
              ),
              if (reasons.isEmpty)
                const Text(
                  'No risk threshold was triggered by available records.',
                )
              else
                ...reasons.map((reason) => Text('• $reason')),
              const SizedBox(height: 8),
              const Text(
                'No labelled outcome dataset is available; this is not a trained prediction model.',
              ),
            ],
          ),
        ),
      ),
      _sectionTitle('Subject performance'),
      if (subjects.isEmpty)
        const _InfoCard(
          title: 'No subject data',
          message: 'Subject-level attendance and marks are not available.',
          icon: Icons.menu_book_outlined,
        )
      else
        ...subjects.map(
          (subject) => Card(
            child: ListTile(
              title: Text(_value(subject['subject_name'])),
              subtitle: Text(
                'Attendance: ${subject['attendance_percentage'] == null ? 'No data' : '${subject['attendance_percentage']}%'} · '
                'Internal marks: ${subject['marks_average'] == null ? 'No data' : '${subject['marks_average']}%'}',
              ),
            ),
          ),
        ),
      _sectionTitle('Personalized recommendations'),
      ...recommendations.map(
        (item) => ListTile(
          leading: const Icon(Icons.lightbulb_outline_rounded),
          title: Text('$item'),
        ),
      ),
      _sectionTitle('Data limitations'),
      if (limitations.isEmpty)
        const Text('No known data limitations.')
      else
        ...limitations.map(
          (item) => ListTile(
            leading: const Icon(Icons.info_outline_rounded),
            title: Text('$item'),
          ),
        ),
      _sectionTitle('Personalized AI Mentor'),
      const Text(
        'Guidance uses your linked academic records only. Suggestions are educational support, not guaranteed predictions.',
      ),
      const SizedBox(height: 8),
      Wrap(
        spacing: 8,
        runSpacing: 4,
        children: _prompts
            .map(
              (prompt) => ActionChip(
                label: Text(prompt),
                onPressed: _working ? null : () => _askMentor(prompt),
              ),
            )
            .toList(),
      ),
      const SizedBox(height: 8),
      TextField(
        controller: _mentorController,
        maxLength: 500,
        minLines: 1,
        maxLines: 3,
        decoration: InputDecoration(
          labelText: 'Ask about your academic progress',
          suffixIcon: IconButton(
            tooltip: 'Ask mentor',
            onPressed: _working ? null : () => _askMentor(),
            icon: const Icon(Icons.send_rounded),
          ),
        ),
      ),
      if (_working) const LinearProgressIndicator(),
      if (_mentorResponse != null) ..._buildMentorResponse(),
    ];
  }

  List<Widget> _buildMentorResponse() {
    final response = _mentorResponse!;
    final plan = _maps(response['study_plan']);
    final limitations = response['data_limitations'] as List? ?? [];
    return [
      Card(
        color: Theme.of(context).colorScheme.primaryContainer,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                _value(
                  response['intent'],
                  fallback: 'Mentor response',
                ).replaceAll('_', ' '),
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              Text(_value(response['reply'])),
              if (plan.isNotEmpty) ...[
                const SizedBox(height: 12),
                const Text(
                  '7-day study plan',
                  style: TextStyle(fontWeight: FontWeight.bold),
                ),
                ...plan.map(
                  (item) => ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text('${item['day']}: ${item['subject']}'),
                    subtitle: Text(_value(item['activity'])),
                  ),
                ),
              ],
              if (limitations.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text('Missing information: ${limitations.join(' ')}'),
              ],
              const SizedBox(height: 8),
              Text(
                _value(response['disclaimer']),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
        ),
      ),
    ];
  }

  List<Widget> _buildStaffContent() {
    final overview = _data ?? {};
    final counts = overview['risk_counts'] as Map<String, dynamic>? ?? {};
    final atRisk = _maps(overview['students_requiring_intervention']);
    final trends = overview['academic_trends'] as Map<String, dynamic>? ?? {};
    return [
      const _InfoCard(
        title: 'Class-scoped insights',
        message: 'Student access is limited by the server to classes assigned to your faculty account.',
        icon: Icons.verified_user_outlined,
      ),
      Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Wrap(
            spacing: 20,
            runSpacing: 12,
            children: [
              _metric('Students', overview['total_students_analyzed']),
              _metric('High risk', counts['high']),
              _metric('Medium risk', counts['medium']),
              _metric('Low risk', counts['low']),
              _metric('Declining trend', trends['declining']),
            ],
          ),
        ),
      ),
      if (overview['model_evaluation'] is Map)
        _InfoCard(
          title: 'Rule-based baseline',
          message:
              (overview['model_evaluation'] as Map)['reason']?.toString() ??
              'Model not evaluated.',
          icon: Icons.info_outline_rounded,
        ),
      _sectionTitle('Students needing attention'),
      if (atRisk.isEmpty)
        const _InfoCard(
          title: 'No students flagged',
          message: 'No high- or medium-risk students are present in the available assigned-class records.',
          icon: Icons.check_circle_outline_rounded,
        )
      else
        ...atRisk.map((row) {
          final student = row['student'] as Map<String, dynamic>? ?? {};
          return Card(
            child: ListTile(
              title: Text(_value(student['name'])),
              subtitle: Text(
                '${_value(row['risk_level']).toUpperCase()} · '
                '${row['attendance']?['overall_percentage'] == null ? 'No attendance totals' : '${row['attendance']['overall_percentage']}% attendance'}',
              ),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: _working ? null : () => _openStudent(row),
            ),
          );
        }),
      if (_selectedStudent != null) ..._buildFacultyStudentReport(),
    ];
  }

  List<Widget> _buildFacultyStudentReport() {
    final report = _selectedStudent!;
    final student = report['student'] as Map<String, dynamic>? ?? {};
    final reasons = report['risk_reasons'] as List? ?? [];
    final attendance = report['attendance'] as Map<String, dynamic>? ?? {};
    final trend = report['attendance_trend'] as Map<String, dynamic>? ?? {};
    final marks = report['internal_marks'] as Map<String, dynamic>? ?? {};
    final subjects = _maps(report['subjects']);
    final recommendations = report['recommendations'] as List? ?? [];
    final limitations = report['data_limitations'] as List? ?? [];
    final risk = _value(report['risk_level'], fallback: 'insufficient_data');
    final intervention = report['latest_intervention'] as Map<String, dynamic>?;
    return [
      _sectionTitle('${_value(student['name'])} · Individual report'),
      Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Risk: ${risk == 'insufficient_data' ? 'INSUFFICIENT DATA' : risk.toUpperCase()}',
              ),
              Text(
                'Attendance: ${attendance['overall_percentage'] == null ? 'Insufficient Data' : '${attendance['overall_percentage']}%'} · '
                'Trend: ${_value(trend['direction'])}',
              ),
              Text(
                'Internal marks: ${marks['average_percentage'] == null ? 'Insufficient Data' : '${marks['average_percentage']}% average'}',
              ),
              Text(
                'Reasons: ${reasons.isEmpty ? 'No threshold reasons.' : reasons.join(' ')}',
              ),
              if (subjects.isNotEmpty) ...[
                const SizedBox(height: 8),
                const Text('Subject indicators'),
                ...subjects.map(
                  (subject) => Text(
                    '${_value(subject['subject_name'])}: attendance '
                    '${subject['attendance_percentage'] == null ? 'Insufficient Data' : '${subject['attendance_percentage']}%'} · marks '
                    '${subject['marks_average'] == null ? 'Insufficient Data' : '${subject['marks_average']}%'}',
                  ),
                ),
              ],
              if (recommendations.isNotEmpty) ...[
                const SizedBox(height: 8),
                const Text('Recommendations'),
                ...recommendations.map((item) => Text('• $item')),
              ],
              if (limitations.isNotEmpty)
                Text('Data limitations: ${limitations.join(' ')}'),
              if (intervention != null) ...[
                const Divider(),
                Text('Last mentoring note: ${_value(intervention['note'])}'),
                Text('Follow-up: ${_value(intervention['follow_up_status'])}'),
              ],
              TextField(
                controller: _noteController,
                maxLength: 2000,
                minLines: 1,
                maxLines: 3,
                decoration: const InputDecoration(
                  labelText: 'Mentoring action',
                ),
              ),
              FilledButton(
                onPressed: _working ? null : _recordMentoringNote,
                child: const Text('Record follow-up'),
              ),
            ],
          ),
        ),
      ),
    ];
  }

  Widget _sectionTitle(String title) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 20, 4, 8),
    child: Text(
      title,
      style: Theme.of(context).textTheme.titleMedium
          ?.copyWith(fontWeight: FontWeight.w700),
    ),
  );

  Widget _metric(String label, dynamic value) => SizedBox(
    width: 110,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('$value', style: Theme.of(context).textTheme.titleLarge),
        Text(label, style: Theme.of(context).textTheme.bodySmall),
      ],
    ),
  );
}

class _InfoCard extends StatelessWidget {
  const _InfoCard({
    required this.title,
    required this.message,
    required this.icon,
  });

  final String title;
  final String message;
  final IconData icon;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Theme.of(context).textTheme.titleSmall),
                const SizedBox(height: 4),
                Text(message),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.error_outline_rounded, size: 40),
          const SizedBox(height: 12),
          Text(message, textAlign: TextAlign.center),
          const SizedBox(height: 12),
          FilledButton(onPressed: onRetry, child: const Text('Try again')),
        ],
      ),
    ),
  );
}
