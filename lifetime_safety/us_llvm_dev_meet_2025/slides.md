---
title: Lifetime analysis in Clang
author: Utkarsh Saxena
download: true
exportFilename: clang-lifetime-analysis
lineNumbers: true
remoteAssets: true
theme: ./theme
# some information about your slides (markdown enabled)
colorschema: dark
contextMenu: true
# https://sli.dev/features/drawing
drawings:
  persist: false
# slide transition: https://sli.dev/guide/animations.html#slide-transitions
transition: zoom
# enable MDC Syntax: https://sli.dev/features/mdc
mdc: true
# make slide text selectable
selectable: true
# take snapshot for each slide in the overview
overviewSnapshots: true
hideInToc: true
layout: cover
---

# Lifetime Safety in Clang


LLVMDev2025 Tech Talk proposal

<!-- Good morning everyone. 

I'm .., 
I work in the ...
and today I'll be talking about our work on a new intra-procedural lifetime analysis in Clang. -->


---
layout: intro
---

# Agenda

1.  Temporal Memory Safety in C++
2.  Moving Forward: A New Intra-Procedural Lifetime Analysis
3.  The C++ Lifetime Model: Core Concepts
4.  Connection to Rust-like Lifetimes
5.  Future Direction


<!-- Here's what we'll cover. 
First, 
the problem space, 
then our proposed solution, 
its core mechanics, 
how it relates to potential Rust-like features, 
and finally, future work. -->

---
layout: section
---

# The Challenge

## **Temporal Memory Safety in C++**

<!-- Let's start by looking at the challenge of temporal memory safety in C++. -->


---
layout: center
---

# The Dangling Pointer Problem

A **dangling pointer** (or reference) points to memory that's no longer valid:
- Deallocated (freed)
- Gone out of scope
- Otherwise invalidated

<br>

Accessing it? **Undefined Behavior (UB)**
- Crashes
- Data corruption
- Security vulnerabilities

<!-- 
A dangling pointer is one that doesn't point to valid memory. 

Accessing it leads to undefined behavior, which can manifest as crashes, data corruption, or security issues. -->

---
layout: center
---

# Dangling Pointer: Example

**Use-after-return**: Accessing stack memory after a function returns.

```cpp
// UaR
std::string_view get_sv() {
  std::string local = "stack";
  return local; // Returns view to 'local' [!code error]
}

// main():
// auto view = get_sv();
// std::cout << view; // UB! 'local' is gone
```

<!-- Here's a classic example: returning a view to a local string. 

Once the function returns, 'local' is destroyed, and 'view' dangles, leading to UB if used. -->


---
layout: center
---

# Why This Matters: Production Impact

**Crash reports at Google**:
*Temporal memory safety* issues are **3x to 8x more frequent** than *spatial safety* issues.

<img src="./ratio.png">

<div class="mt-4 text-sm text-gray-600 dark:text-gray-400">
  Temporal vs spatial breakdown (based on # unique crashes moving avg)
</div>


<!-- 

In production, GWP-ASan data shows that temporal memory safety issues are significantly more common than spatial ones.
Often 3 to 8 times.

There's a large opportunity here.
-->

---
layout: center
---

# Clang's Current Lifetime Analysis

Clang already has a **statement-local** lifetime analysis:
- Detects some obvious dangling pointer issues *within a single statement*.
- Uses existing annotations and heuristics to understand pointer-like types.


Let's look at what it *can* do today...


<!--

Clang's existing analysis operates locally within a single statement. 

It can catch some issues using annotations and heuristics. 

Let's look at what it *can* do today...

-->


---
layout: center
---

# Current Analysis: Temporaries

```cpp
void foo() {
  std::string_view sv = std::string("temporary"); // WARNING: dangling reference to a temporary // [!code error]
                     // ^^^^^^^^^^^^^^^^^^^^^^^^ 
  std::cout << sv;
}
```

```cpp
std::string_view get_name() {
  return std::string("temporary"); // WARNING: reference to temporary is returned [!code error]
      // ^^^^^^^^^^^^^^^^^^^^^^^^
}
```

<!-- For example, 

it warns when a view is bound to a temporary that's immediately destroyed, 

or when such a temporary-backed view is returned. -->


---
layout: center
---

# Current Analysis: Using **clang::lifetimebound**

The `[[clang::lifetimebound]]` attribute informs the compiler that the return value contains a reference to the annotated parameter.

```cpp
std::string_view Trim(const std::string& input [[clang::lifetimebound]]);

void get_temporary_view_via_bound_call() {
  std::string_view sv = Trim(std::string("temporary")); // WARNING: dangling reference to a temporary // [!code error]
                         //  ^^^^^^^^^^^^^^^^^^^^^^^^
}
```

<!-- With lifetimebound, Clang understands that the returned view's lifetime is tied to the input, 

and can correctly warning if the input is a temporary. -->

---
layout: center
---

# Current Analysis: Container heuristics

```cpp
void example_container() {
  std::vector<std::string_view> views;

  views.push_back(std::string("temporary")); // WARNING: View in vector dangles. [!code error]
}
```

<!-- It also has heuristics for common containers, like warning when a temporary is pushed into a vector of views, as the view will dangle immediately. -->


---
layout: default
---

# Impact of Recent Improvements (2024)



Even with statement-local enhancements, the benefits were clear:

- Surfaced **O(100s)** UaF bugs at Google.
- **~X% reduction** in *stack-use-after-free* findings reported by nightly sanitizer runs.
- **~Y% reduction** of *heap-use-after-free* in ASAN on prod.



<img src="./C52d6NX2Wgm9fm4.png" width="80%">


<!-- 
Enhancements in 2024, even within statement-local limits, yielded significant results: 
- hundreds of bugs fixed 
- measurable reductions in UaF reports

This motivated further investment in more powerful techniques.
-->


---

# Current Analysis: Limitations

Doesn't track object lifetimes across **multiple statements**.

<div class="grid grid-cols-2 gap-4">
<div v-click>

**CANNOT CATCH: Simple Reassignment:**
```cpp
std::string_view foo() {
  std::string local = "text";
  std::string_view view;
  view = local; // No warning here [!code warning]
  return view;  // UB. [!code warning]
}
```
</div>
<div v-click>

**CANNOT CATCH: Control Flow:**
```cpp
std::string_view bar(bool cond) {
  std::string local_str;
  std::string_view view = "default";
  if (cond) {
    local_str = "small scope"; // [!code warning]
    view = local_str; // No warning here [!code warning]
  }
  return view;  // UB.
}
```
</div>
</div>

<!-- 
However, the current analysis is primarily statement-local. 

It misses UaFs 
- when lifetimes span multiple statements 
- involve control flow.

This leaves a significant gap in detection capabilities. -->

---
layout: section
---

# Moving Forward

## **Intra-Procedural Lifetime Analysis in Clang**

<!-- This leads us to our new proposal: an intra-procedural lifetime analysis. -->

---
layout: center
---

# The Vision: Beyond Single Statements

We need to track how objects live and die across:
  - Multiple statements
  - Conditional branches (`if/else`)
  - Loops

This requires a **flow-sensitive, intra-procedural** analysis.


```cpp
std::string_view get_view(bool condition, const std::string& safe_str) {
  std::string_view result = safe_str;
  std::string local = "local";

  if (condition) {
    result = local; // 'result' now points to 'local'
  }
  return result; // POTENTIAL UaR [!code error]
} // 'local' is destroyed here.
```
<!-- 
The vision is to track lifetimes across entire function bodies, understanding control flow.

and significantly improve detection of UaF/UaR bugs.
-->

---
layout: center
---

# Goals of the New Analysis


<v-clicks>

* **Compiler-Integrated:** As a Clang warning.
* **Enabled by default** in google and upstream Clang.

* **Incremental Rollout**: *Configurable strictness* and *Gradual typing*

* **Leverage existing annotations**
* Laying foundation for **Rust-like lifetimes**.

</v-clicks>

<!--
Our goals is to implement this as a Clang warning, and not a separate tool like ClangTidy. 
- This allows broader adoption and catches bugs early during development as hard compile errors.

We want to rollout this analysis incrementally. To do that, 
- We'll support "multiple strictness modes" allowing easier adoption.
- We'll support "gradual typing": 
    - It should not require all of C++ codebases to be annotated to use this analysis. 
    - it should be "useful now" with the existing codebase and existing annotations.

Importantly, we want to lay the foundation for **Rust-like lifetimes**:
- and future Rust-like lifetimes must be able to reuse the analysis.
-->

---
layout: center
---

# Non-Goals

<v-clicks>

- **Complete Memory Safety Solution for C++**

- **Introducing Rust-like Lifetimes *Syntax* into C++**

- **Formal Borrow Checker**

- **Alias Modeling**

</v-clicks>

<!-- 

- To be clear, this won't make C++ fully memory safe. The analysis will improve detection of unsafe patterns, but it will still be possible to write incorrect code with UaF and UB.

- This does not introduce Rust-like Lifetimes *Syntax* into C++. 
  - That said, the *internal model* shares concepts with Rust-lifetime formulation, 
  - and paves the way for such lifetimes.

- This is not Formal Borrow Checker:
  - But this analysis could be later used to enforce such rules.

- We will not perform complex pointer aliasing analysis.
  - and heuristics and approximations will be used where necessary.

-->

---
layout: section
---

# The C++ Lifetime Model
## Core Concepts

<!-- Now, let's take a look at the core concepts of the C++ lifetime model. -->


---
layout: center
---

# High-Level Approach

CFG-based, flow-sensitive analysis inspired by Rust's Polonius.

<v-clicks>

1.  **"Loans" Model Borrows:** Pointer/reference/view creation → `Loan` from a memory location.

2.  **"OriginSets" Track Sources:** Pointer-like variables/expressions have an `OriginSet` (*Set of Loans*)

3.  **Propagate Loan Sets:** Track how `OriginSet` changes across CFG (assignments, calls, merges).

4.  **Identify Loan Expiry:** Memory backing a `Loan` becomes invalid (e.g., scope end).

5.  **Detect Unsafe Use:** Error if an `OriginSet` is used when any of its contained `Loans` might be expired.

</v-clicks>

<!-- 
At its core, this is a CFG-based, flow-sensitive, alias-based analysis inspired by Rust's Polonius. 

It involves 

modeling borrows as Loans, 

tracking sets of these Loans in OriginSets, 

propagating these loans across the CFG .

identifying when Loans expire, (e.g., at the end of a scope)

and then detecting unsafe uses of expired loans.
-->

---
layout: center
---

# Loans

A "Loan" represents the act of borrowing from a specific memory location.

Identified by:
  -   **Where** it's created (the "borrow site").
  -   **What** memory is borrowed (e.g., `x`, `s_obj.y`).

```cpp {all|3,7,11}
void example() {
  int x;
  int* p1 = &x; // A Loan L1 is created, borrowing from 'x'.

  struct S { int y; };
  S s_obj;
  int* p2 = &s_obj.y; // Loan L2 borrows from 's_obj.y'.

  std::string str_val = "hello";
  // string_view constructor implicitly borrows from 'str_val'.
  std::string_view sv = str_val; // Loan L3 borrows from 'str_val'.
}
```

<!-- 
A "Loan" represents the act of borrowing from a specific memory location.

It's defined by "where it occurs" (the "borrow site") 
and what memory is borrowed. Each borrow act results in a unique Loan. -->

---
layout: center
---

# OriginSets

An "OriginSet" is a symbolic identifier (e.g., `'Oa`) associated with *pointer-like variables and expressions*.

<v-clicks>

-   It represents the **set of all possible Loans** that the variable/expression might hold at any given program point.
-   Think of it as the potential **sources** of the data a pointer refers to.

</v-clicks>

```cpp
int* p;               // int*'Op  p;

std::string_view v;  // std::string_view'Ov v;
```

<!-- none. -->


---
layout: center
---

# Linking OriginSets and Loans

```cpp{all|3|5|5-6|5-7}
void example() {
  std::string data = "Initial Data";
  std::string_view view; // Origin of view: Ov = {} (empty)

  view = data;
  // 1. A new Loan, L, is created (representing the borrow of 'data').
  // 2. This L is added to view's Origin => Ov = {L}
}
```

<!-- When a variable borrows from a data source, a Loan is created for that borrow. 

This Loan is then tracked by the variable's OriginSet, indicating its current source. -->



---
layout: center
---

# Flow Sensitivity: Propagation

Reassignments overwrites the old origin set.

```cpp {all|4|6-7|9-11}
void overwrite_origin_example() {
  std::string source_A = "Alpha";
  std::string source_B = "Beta";
  std::string_view ptr; // Origin of ptr: O_ptr = {}

  ptr = source_A;
  // O_ptr = {L_source_A} (Loan for 'source_A')

  ptr = source_B;
  // O_ptr is overwritten.
  // O_ptr = {L_source_B} (Loan for 'source_B')
}
```

<!-- When a variable is reassigned, its OriginSet is overwritten to reflect the new source.

The prior loans for that OriginSet are forgotten. -->

---
layout: center
---

# Flow Sensitivity: Merging at Joins

Origin sets merge at join points.

```cpp {all|2|5-7|9-10|12-13}
void merge(bool condition, const std::string& b) {
  std::string_view view; // Origin of view: O_view = {}

  if (condition) {
    std::string a = "Local in IF";
    view = a;
    // Path 1: O_view = {L_a} (Loan for 'a')
  } else {
    view = b;
    // Path 2: O_view = {L_b} (Loan for 'b')
  }
  // "Join" point:
  // O_view = {L_a, L_b}
}
```

<!-- At control flow merge points, like after an if/else, a variable's OriginSet becomes the union of Loan sets from all incoming branches. -->


---
layout: center
---

# Gradual Typing: Opaque Loans

When a pointer's source is unknown (e.g., from unannotated functions), an `OPAQUE` Loan is used.

*Conservatively* assumed to *never expire* to avoid false positives.

**Example:**
```cpp
std::string_view get_unclear_view();

void example_opaque_return() {
  std::string_view sv;
  sv = get_unclear_view();
  // OriginSet of sv is now {OPAQUE}.
}
```

<!-- For unknown sources, like unannotated function returns, we use an OPAQUE Loan. This is assumed to never expire within the current analysis to prevent false alarms. 

This "gradual typing" approach is important for incremental adoption. This allows the analysis to be useful on today's codebase where not all functions have explicit lifetime contracts. 

-->


---
layout: default
---

# Configurable Strictness: Permissive vs. Strict

Choose your trade-off: fewer false positives or catching more potential bugs.

<div class="grid grid-cols-2 gap-8 pt-6">
<div v-click>

**Permissive Mode**: *Default*

-   **Error** if **ALL** Loans are expired.
-   **Goal:** High-confidence warnings, minimal noise.

```cpp
std::string_view permissive() {
  std::string local = "local";
  view = local;  // error. [!code error]
  return view;
}
```
</div>
<div v-click>

**Strict Mode**: *Opt-in*

-   **Error** if **ANY** Loan is expired.
-   **Goal:** More issues, more false positives.

```cpp
std::string_view strict(bool condition, 
                       const std::string& param) {
  std::string_view view;
  std::string local = "local";
  if (condition) {
    view = local;  // error. [!code error]
  } else {
    view = param;
  }
  return view;
}
```
</div>
</div>

<!-- We offer two strictness modes. 

Permissive, the default, errors if all potential loans are expired. 

Strict errors if any loan might be expired, catching more but with a risk of more false positives. 

-->


---
layout: center
---

# Opportunistic Bug Finding

Heuristics to track pointers *within* common types like structs and containers.


**Example:**
```cpp
struct MyStruct {
  std::string_view field; // Member has its own conceptual Origin // [!code warning]
};
void struct_member_dangle() {
  MyStruct instance;
  std::string long_lived_str = "safe";

  if (/*some_condition*/) {
    std::string short_lived_str = "unsafe";
    instance.field = short_lived_str; // [!code error]
  }
  use(instance); // UB: Note: 'instance' used here.
}
```

<!-- Skip code explanation 
Beyond top-level variables, the analysis would use heuristics to find bugs in common patterns involving pointers **within** *structs or containers*.

This would rely on specific knowledge of common types (like struct members).

-->


---
layout: section
---

# Connection to Rust-like Lifetimes

<!-- Let's discuss how this work connects to potential Rust-like lifetime annotations. -->


---
layout: center
---

# Shared Semantics

<v-clicks>

-   C++ lifetime model (Origin Sets tracking set of Loans) shares its core **semantic definition of "lifetime"** with **Rust's Polonius**.
-   Built to **natively understand and consume** more explicit, Rust-style lifetime syntax if/when introduced in C++.

</v-clicks>


<!-- 
The CFG-based dataflow infrastructure we're building is inherently compatible with such explicit lifetime systems.

It's an **intermediate step** that provides value *today* while being adaptable for *tomorrow*.
-->

---
layout: center
---

# Future-Proofing: Integrating Explicit Lifetimes

If Clang adopts Rust-like lifetime annotations (e.g., `T& [[clang::lifetime(a)]]`):

1.  **Increased Precision:**
    -   User annotations directly inform the Origin/Loan relationships.
    -   Less reliance on `OPAQUE` Loans and heuristics.

2.  **Reduced Reliance on Heuristics:**
    - Lifetime dependencies of nested pointers (within containers, structs) clearer.
    - Reduce the need for special "opportunistic" handling.

<!-- 
If Clang adopts explicit Rust-like lifetime annotations, this existing framework could directly leverage them.

Our analysis gains precision from user input and relies less on opaque loans or heuristics, especially for nested types.
 -->

---
layout: section
---

# Future Directions

<!-- Finally, let's look at future directions for this analysis. -->


---
layout: center
zoom: 1.1
---

# Annotation Suggestions

```cpp
std::string_view Identity(std::string_view in) { 
  return in;  // warning: Add [[lifetimebound]] on 'in'
}
```

High-quality suggestions have previously helped uncover *~100 bugs*.

<!-- 
Annotations remain the only way to communicate lifetime contracts across function boundaries.

One possible direction could be to suggest lifetimebound annotations where appropriate. These suggestions have historically uncovered 100s of bugs.
-->

---
layout: center
zoom: 1.1
---

# Annotation Verification

```cpp
std::string Copy(std::string_view in [[clang::lifetimebound]]) { 
             // ^ warning: lifetimebound param 'in' is not returned.
    std::string out = std::string(in);
    return out;
}
```

Ensure declared lifetime contracts match actual implementation behavior.

<!-- We can also verify existing annotations, ensuring declared contracts match the actual implementation, preventing mismatches.

For example, here we have param `in` marked as lifetimebound but is actually not returned.
 -->


---
layout: center
zoom: 1.1
---

# Iterator Invalidation

**Exclusivity** for some *opt-in* types.

```cpp
void foo() {
    std::vector<int> v = {1, 2, 3};
    auto it = v.begin();
    v.push_back(4); // error: modifying 'v' invalidates 'it'. // [!code error]
    std::cout << (*it);
}
```

<!-- Looking further, we could model iterator invalidation, potentially using opt-in exclusivity rules for specific types. -->


---
layout: center
---

# Thank You! 
## Questions ?


<!-- <div class="absolute bottom-4 right-4 w-1/2 text-xs opacity-75"> -->
  <p class="text-left mb-1 font-italic">Fun Finding from the a prototype:</p>
```cpp
// [!code word:model_output]
std::string_view Foo(std::string model_output) {
  std::string_view stripped_text = absl::StripSuffix(model_output, "\\n");
  stripped_text = absl::StripSuffix(stripped_text, "\n");
  if (absl::StartsWith(stripped_text, "\"")) {
    stripped_text = absl::StripPrefix(stripped_text, "\"");
  }
  if (absl::StartsWith(stripped_text, "'")) {
    stripped_text = absl::StripPrefix(stripped_text, "'");
  }
  return stripped_text; // error: returning stack addr 'model_output'. [!code error]
}
// Note: absl::Strip* are marked lifetimebound
```
<!-- </div> -->

<!--

 That concludes the presentation. 

Thank you for your time. 

I'm happy to take any questions. 

And here's a fun real-world bug our prototype caught. -->
